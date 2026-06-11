#!/usr/bin/env python3
"""Fail-closed local LoRA/QLoRA trainer for Ayla V14.

Preflight uses only the standard library. ML dependencies are imported only for
an actual training run. The trainer consumes deterministic train/validation/test
splits produced by the TypeScript hardening stage and refuses contaminated data.
"""
from __future__ import annotations

import argparse
import inspect
import json
import platform
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

SCHEMA_VERSION = "AYLA_HF_LORA_TRAINER_CONFIG_V1"
RESULT_SCHEMA_VERSION = "AYLA_HF_LORA_TRAINING_RESULT_V2"


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        fail(f"TRAINER_CONFIG_READ_FAILED: {exc}")
    if not isinstance(value, dict):
        fail("TRAINER_CONFIG_MUST_BE_OBJECT")
    return value


def read_jsonl(path: Path, allow_empty: bool = False) -> List[Dict[str, Any]]:
    if not path.is_file():
        fail(f"TRAINING_DATASET_FILE_NOT_FOUND: {path}")
    records: List[Dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            fail(f"TRAINING_DATASET_INVALID_JSON_LINE_{line_number}: {exc}")
        if not isinstance(record, dict):
            fail(f"TRAINING_DATASET_RECORD_NOT_OBJECT_LINE_{line_number}")
        messages = record.get("messages")
        if not isinstance(messages, list) or not messages:
            fail(f"TRAINING_DATASET_MESSAGES_MISSING_LINE_{line_number}")
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant", "tool"}:
                fail(f"TRAINING_DATASET_INVALID_MESSAGE_LINE_{line_number}")
            if not isinstance(message.get("content"), str) or not message["content"].strip():
                fail(f"TRAINING_DATASET_EMPTY_MESSAGE_LINE_{line_number}")
        records.append(record)
    if not records and not allow_empty:
        fail(f"TRAINING_DATASET_EMPTY: {path}")
    return records


def positive_number(value: Any, name: str, integer: bool = False) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        fail(f"TRAINER_INVALID_{name.upper()}")
    return int(value) if integer else float(value)


def dataset_paths(config: Dict[str, Any]) -> Dict[str, Path]:
    raw = config.get("dataset_paths")
    if isinstance(raw, dict):
        paths = {name: Path(str(raw.get(name, ""))).expanduser().resolve() for name in ("train", "validation", "test")}
    else:
        train = Path(str(config.get("dataset_path", ""))).expanduser().resolve()
        paths = {"train": train, "validation": Path(""), "test": Path("")}
    if not paths["train"].is_file():
        fail("TRAINING_TRAIN_DATASET_FILE_NOT_FOUND")
    return paths


def validate_config(config_path: Path) -> Dict[str, Any]:
    config = read_json(config_path)
    if config.get("schema_version") != SCHEMA_VERSION:
        fail("TRAINER_CONFIG_SCHEMA_VERSION_UNSUPPORTED")
    method = config.get("method")
    if method not in {"lora", "qlora"}:
        fail("TRAINER_METHOD_MUST_BE_LORA_OR_QLORA")
    base_model = config.get("base_model")
    if not isinstance(base_model, str) or not base_model.strip():
        fail("TRAINER_BASE_MODEL_REQUIRED")
    paths = dataset_paths(config)
    output_dir = Path(str(config.get("output_dir", ""))).expanduser().resolve()
    for path in paths.values():
        if str(path) and path == output_dir:
            fail("TRAINER_OUTPUT_DIRECTORY_OVERLAPS_DATASET")
    train_records = read_jsonl(paths["train"])
    validation_records = read_jsonl(paths["validation"], allow_empty=True) if paths["validation"].is_file() else []
    test_records = read_jsonl(paths["test"], allow_empty=True) if paths["test"].is_file() else []
    hardening_path = Path(str(config.get("hardening_report_path", ""))).expanduser().resolve()
    if not hardening_path.is_file():
        fail("TRAINING_HARDENING_REPORT_NOT_FOUND")
    hardening = read_json(hardening_path)
    if int(hardening.get("contamination_count", 0)) != 0:
        fail("TRAINING_BENCHMARK_CONTAMINATION_DETECTED")
    if int(hardening.get("split_counts", {}).get("train", -1)) != len(train_records):
        fail("TRAINING_HARDENING_TRAIN_COUNT_MISMATCH")

    hyper = config.get("hyperparameters")
    if not isinstance(hyper, dict):
        fail("TRAINER_HYPERPARAMETERS_REQUIRED")
    for name, integer in [
        ("epochs", False), ("learning_rate", False), ("batch_size", True),
        ("gradient_accumulation_steps", True), ("max_sequence_length", True),
        ("lora_rank", True), ("lora_alpha", True), ("early_stopping_patience", True),
    ]:
        positive_number(hyper.get(name), name, integer=integer)
    dropout = hyper.get("lora_dropout")
    if not isinstance(dropout, (int, float)) or not 0 <= dropout < 1:
        fail("TRAINER_INVALID_LORA_DROPOUT")
    return {
        "schema_version": "AYLA_HF_LORA_TRAINER_PREFLIGHT_V2",
        "config_path": str(config_path.resolve()),
        "dataset_paths": {key: str(value) for key, value in paths.items()},
        "output_dir": str(output_dir),
        "base_model": base_model,
        "method": method,
        "split_counts": {"train": len(train_records), "validation": len(validation_records), "test": len(test_records)},
        "hardening_report_path": str(hardening_path),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "valid": True,
    }


def require_training_dependencies(method: str) -> Dict[str, Any]:
    try:
        import torch
        import transformers
        import datasets
        import peft
        import trl
    except Exception as exc:  # noqa: BLE001
        fail(f"TRAINING_DEPENDENCY_IMPORT_FAILED: {exc}")
    versions: Dict[str, Any] = {
        "torch": getattr(torch, "__version__", "unknown"),
        "transformers": getattr(transformers, "__version__", "unknown"),
        "datasets": getattr(datasets, "__version__", "unknown"),
        "peft": getattr(peft, "__version__", "unknown"),
        "trl": getattr(trl, "__version__", "unknown"),
        "cuda_available": bool(torch.cuda.is_available()),
    }
    if not torch.cuda.is_available():
        fail("CUDA_REQUIRED_FOR_LOCAL_GEMMA_ADAPTER_TRAINING")
    if method == "qlora":
        try:
            import bitsandbytes
            versions["bitsandbytes"] = getattr(bitsandbytes, "__version__", "unknown")
        except Exception as exc:  # noqa: BLE001
            fail(f"QLORA_BITSANDBYTES_IMPORT_FAILED: {exc}")
    return versions


def compatible_kwargs(callable_obj: Any, values: Dict[str, Any]) -> Dict[str, Any]:
    parameters = inspect.signature(callable_obj).parameters
    return {key: value for key, value in values.items() if key in parameters}


def render_training_text(tokenizer: Any, messages: Iterable[Dict[str, str]]) -> str:
    if hasattr(tokenizer, "apply_chat_template"):
        try:
            return tokenizer.apply_chat_template(list(messages), tokenize=False, add_generation_prompt=False)
        except Exception:  # noqa: BLE001
            pass
    return "\n".join(f"<{message['role']}>\n{message['content']}" for message in messages)


def train(config_path: Path) -> Dict[str, Any]:
    preflight = validate_config(config_path)
    config = read_json(config_path)
    method = str(config["method"])
    versions = require_training_dependencies(method)

    import torch
    from datasets import Dataset
    from peft import LoraConfig, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, EarlyStoppingCallback, set_seed
    from trl import SFTConfig, SFTTrainer

    paths = {key: Path(value) for key, value in preflight["dataset_paths"].items()}
    output_dir = Path(preflight["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    split_records = {
        "train": read_jsonl(paths["train"]),
        "validation": read_jsonl(paths["validation"], allow_empty=True) if paths["validation"].is_file() else [],
        "test": read_jsonl(paths["test"], allow_empty=True) if paths["test"].is_file() else [],
    }
    hyper = config["hyperparameters"]
    seed = int(hyper.get("seed", 42))
    set_seed(seed)

    try:
        tokenizer = AutoTokenizer.from_pretrained(config["base_model"], trust_remote_code=False, use_fast=True)
    except Exception:  # noqa: BLE001
        tokenizer = AutoTokenizer.from_pretrained(config["base_model"], trust_remote_code=False, use_fast=False)
    if tokenizer.pad_token_id is None:
        if tokenizer.eos_token_id is None:
            fail("TOKENIZER_HAS_NO_PAD_OR_EOS_TOKEN")
        tokenizer.pad_token = tokenizer.eos_token

    model_kwargs: Dict[str, Any] = {"device_map": "auto", "trust_remote_code": False, "low_cpu_mem_usage": True}
    if method == "qlora":
        compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=compute_dtype
        )
    else:
        model_kwargs["torch_dtype"] = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

    model = AutoModelForCausalLM.from_pretrained(config["base_model"], **model_kwargs)
    if method == "qlora":
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    if hasattr(model, "config"):
        model.config.use_cache = False

    datasets = {
        name: Dataset.from_list([{"text": render_training_text(tokenizer, record["messages"])} for record in records])
        for name, records in split_records.items() if records
    }
    lora_config = LoraConfig(
        r=int(hyper["lora_rank"]), lora_alpha=int(hyper["lora_alpha"]), lora_dropout=float(hyper["lora_dropout"]),
        bias="none", task_type="CAUSAL_LM", target_modules="all-linear"
    )
    has_validation = "validation" in datasets
    sft_values: Dict[str, Any] = {
        "output_dir": str(output_dir),
        "num_train_epochs": float(hyper["epochs"]),
        "learning_rate": float(hyper["learning_rate"]),
        "per_device_train_batch_size": int(hyper["batch_size"]),
        "per_device_eval_batch_size": 1,
        "gradient_accumulation_steps": int(hyper["gradient_accumulation_steps"]),
        "warmup_ratio": float(hyper["warmup_ratio"]),
        "logging_steps": 1,
        "save_strategy": "epoch",
        "eval_strategy": "epoch" if has_validation else "no",
        "evaluation_strategy": "epoch" if has_validation else "no",
        "load_best_model_at_end": bool(has_validation),
        "metric_for_best_model": "eval_loss",
        "greater_is_better": False,
        "save_total_limit": 2,
        "report_to": "none",
        "bf16": bool(torch.cuda.is_bf16_supported()),
        "fp16": not bool(torch.cuda.is_bf16_supported()),
        "gradient_checkpointing": True,
        "dataset_text_field": "text",
        "packing": False,
        "max_length": int(hyper["max_sequence_length"]),
        "max_seq_length": int(hyper["max_sequence_length"]),
        "seed": seed,
    }
    sft_config = SFTConfig(**compatible_kwargs(SFTConfig, sft_values))
    callbacks = [EarlyStoppingCallback(early_stopping_patience=int(hyper["early_stopping_patience"]))] if has_validation else []
    trainer_values: Dict[str, Any] = {
        "model": model,
        "args": sft_config,
        "train_dataset": datasets["train"],
        "eval_dataset": datasets.get("validation"),
        "peft_config": lora_config,
        "processing_class": tokenizer,
        "tokenizer": tokenizer,
        "callbacks": callbacks,
    }
    trainer = SFTTrainer(**compatible_kwargs(SFTTrainer, trainer_values))

    started = time.time()
    train_output = trainer.train()
    test_metrics: Dict[str, Any] = {}
    if "test" in datasets:
        test_metrics = trainer.evaluate(datasets["test"], metric_key_prefix="test")
    trainer.save_model(str(output_dir))
    tokenizer.save_pretrained(str(output_dir))
    duration = time.time() - started
    metrics = getattr(train_output, "metrics", {}) or {}
    result = {
        "schema_version": RESULT_SCHEMA_VERSION,
        "status": "completed",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base_model": config["base_model"],
        "method": method,
        "dataset_paths": preflight["dataset_paths"],
        "split_counts": preflight["split_counts"],
        "output_dir": str(output_dir),
        "duration_seconds": duration,
        "metrics": metrics,
        "test_metrics": test_metrics,
        "best_checkpoint": getattr(trainer.state, "best_model_checkpoint", None),
        "best_metric": getattr(trainer.state, "best_metric", None),
        "seed": seed,
        "versions": versions,
        "adapter_only": True,
        "no_cloud_fallback": True,
    }
    (output_dir / "training_result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--validate-config", action="store_true")
    args = parser.parse_args()
    config_path = Path(args.config).expanduser().resolve()
    result = validate_config(config_path) if args.validate_config else train(config_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"status": "blocked", "blocker": str(exc)}, indent=2), file=sys.stderr)
        sys.exit(1)
