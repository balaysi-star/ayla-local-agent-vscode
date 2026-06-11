#!/usr/bin/env python3
"""Bounded Python AST intelligence for the Ayla local gateway.

This script is intentionally read-only. Node validates workspace/scope boundaries before
invocation; the script repeats root containment checks and never imports target modules.
"""
from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import os
from pathlib import Path
from typing import Iterable

BLOCKED_DIRS = {".git", ".venv", "venv", "node_modules", "dist", "out", ".local", "__pycache__"}


def normalize(path: Path) -> str:
    return path.as_posix()


def inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def iter_python_files(root: Path, scopes: list[str], glob_pattern: str | None) -> Iterable[Path]:
    starts = [root / scope for scope in scopes] if scopes else [root]
    for start in starts:
        if not inside(root, start) or not start.exists():
            continue
        if start.is_file():
            candidates = [start]
        else:
            candidates = start.rglob("*.py")
        for path in candidates:
            rel = path.resolve().relative_to(root.resolve())
            if any(part in BLOCKED_DIRS for part in rel.parts):
                continue
            rel_text = normalize(rel)
            if glob_pattern and not fnmatch.fnmatch(rel_text, glob_pattern):
                continue
            yield path


def parse_file(root: Path, path: Path) -> tuple[ast.AST, str, str]:
    if not inside(root, path):
        raise ValueError("TARGET_PATH_OUT_OF_WORKSPACE")
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    rel = normalize(path.resolve().relative_to(root.resolve()))
    return tree, source, rel


def qualified_functions(tree: ast.AST) -> Iterable[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]]:
    class Visitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self.stack: list[str] = []
            self.items: list[tuple[str, ast.FunctionDef | ast.AsyncFunctionDef]] = []

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            name = ".".join([*self.stack, node.name])
            self.items.append((name, node))
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            name = ".".join([*self.stack, node.name])
            self.items.append((name, node))
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

    visitor = Visitor()
    visitor.visit(tree)
    return visitor.items


def call_name(node: ast.Call) -> str | None:
    fn = node.func
    if isinstance(fn, ast.Name):
        return fn.id
    if isinstance(fn, ast.Attribute):
        parts: list[str] = [fn.attr]
        value = fn.value
        while isinstance(value, ast.Attribute):
            parts.append(value.attr)
            value = value.value
        if isinstance(value, ast.Name):
            parts.append(value.id)
        return ".".join(reversed(parts))
    return None


def node_signature(node: ast.AST) -> str:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = [arg.arg for arg in node.args.posonlyargs + node.args.args]
        if node.args.vararg:
            args.append("*" + node.args.vararg.arg)
        args.extend(arg.arg for arg in node.args.kwonlyargs)
        if node.args.kwarg:
            args.append("**" + node.args.kwarg.arg)
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        return f"{prefix} {node.name}({', '.join(args)})"
    if isinstance(node, ast.ClassDef):
        bases = [ast.unparse(base) for base in node.bases]
        return f"class {node.name}({', '.join(bases)})" if bases else f"class {node.name}"
    return type(node).__name__


def outline(root: Path, path: Path) -> dict:
    tree, _, rel = parse_file(root, path)
    symbols: list[dict] = []
    imports: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            symbols.append({"kind": type(node).__name__, "name": node.name, "line": node.lineno, "signature": node_signature(node)})
        elif isinstance(node, ast.Import):
            imports.append({"line": node.lineno, "module": ",".join(alias.name for alias in node.names)})
        elif isinstance(node, ast.ImportFrom):
            module = "." * node.level + (node.module or "")
            imports.append({"line": node.lineno, "module": module, "names": [alias.name for alias in node.names]})
    symbols.sort(key=lambda item: item["line"])
    imports.sort(key=lambda item: item["line"])
    return {"schema": "PYTHON_AST_OUTLINE_V1", "file": rel, "symbols": symbols[:200], "imports": imports[:200]}


def import_graph(root: Path, scopes: list[str], glob_pattern: str | None) -> dict:
    entries: list[dict] = []
    for path in iter_python_files(root, scopes, glob_pattern):
        try:
            tree, _, rel = parse_file(root, path)
        except (SyntaxError, UnicodeDecodeError):
            continue
        modules: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                modules.append("." * node.level + (node.module or ""))
        entries.append({"file": rel, "imports": sorted(set(modules))})
    return {"schema": "PYTHON_IMPORT_GRAPH_V1", "files": entries[:300]}


def definitions(root: Path, scopes: list[str], symbol: str) -> dict:
    matches: list[dict] = []
    for path in iter_python_files(root, scopes, None):
        try:
            tree, _, rel = parse_file(root, path)
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol:
                matches.append({"file": rel, "line": node.lineno, "kind": type(node).__name__, "signature": node_signature(node)})
    return {"schema": "PYTHON_DEFINITIONS_V1", "symbol": symbol, "matches": matches[:200]}


def references(root: Path, scopes: list[str], symbol: str) -> dict:
    matches: list[dict] = []
    for path in iter_python_files(root, scopes, None):
        try:
            tree, _, rel = parse_file(root, path)
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == symbol:
                matches.append({"file": rel, "line": node.lineno, "column": node.col_offset, "context": type(node.ctx).__name__})
            elif isinstance(node, ast.Attribute) and node.attr == symbol:
                matches.append({"file": rel, "line": node.lineno, "column": node.col_offset, "context": "Attribute"})
    return {"schema": "PYTHON_REFERENCES_V1", "symbol": symbol, "matches": matches[:300]}


def callers(root: Path, scopes: list[str], symbol: str) -> dict:
    matches: list[dict] = []
    for path in iter_python_files(root, scopes, None):
        try:
            tree, _, rel = parse_file(root, path)
        except (SyntaxError, UnicodeDecodeError):
            continue
        for qualified, function_node in qualified_functions(tree):
            for node in ast.walk(function_node):
                if isinstance(node, ast.Call):
                    name = call_name(node)
                    if name and name.split(".")[-1] == symbol:
                        matches.append({"file": rel, "line": node.lineno, "caller": qualified, "call": name})
    return {"schema": "PYTHON_CALLERS_V1", "symbol": symbol, "matches": matches[:300]}


def callees(root: Path, scopes: list[str], symbol: str) -> dict:
    matches: list[dict] = []
    for path in iter_python_files(root, scopes, None):
        try:
            tree, _, rel = parse_file(root, path)
        except (SyntaxError, UnicodeDecodeError):
            continue
        for qualified, function_node in qualified_functions(tree):
            if qualified == symbol or qualified.split(".")[-1] == symbol:
                calls = sorted({name for node in ast.walk(function_node) if isinstance(node, ast.Call) and (name := call_name(node))})
                matches.append({"file": rel, "line": function_node.lineno, "function": qualified, "calls": calls})
    return {"schema": "PYTHON_CALLEES_V1", "symbol": symbol, "matches": matches[:200]}


def class_hierarchy(root: Path, scopes: list[str], glob_pattern: str | None) -> dict:
    classes: list[dict] = []
    for path in iter_python_files(root, scopes, glob_pattern):
        try:
            tree, _, rel = parse_file(root, path)
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                classes.append({"file": rel, "line": node.lineno, "class": node.name, "bases": [ast.unparse(base) for base in node.bases]})
    return {"schema": "PYTHON_CLASS_HIERARCHY_V1", "classes": classes[:300]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["outline", "import-graph", "find-definition", "find-references", "callers", "callees", "class-hierarchy"])
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--path")
    parser.add_argument("--symbol")
    parser.add_argument("--glob")
    parser.add_argument("--scope", action="append", default=[])
    args = parser.parse_args()

    root = Path(args.workspace).resolve()
    try:
        if args.command == "outline":
            if not args.path:
                raise ValueError("TARGET_PATH_MISSING")
            result = outline(root, (root / args.path).resolve())
        elif args.command == "import-graph":
            result = import_graph(root, args.scope, args.glob)
        elif args.command == "find-definition":
            if not args.symbol:
                raise ValueError("SYMBOL_MISSING")
            result = definitions(root, args.scope, args.symbol)
        elif args.command == "find-references":
            if not args.symbol:
                raise ValueError("SYMBOL_MISSING")
            result = references(root, args.scope, args.symbol)
        elif args.command == "callers":
            if not args.symbol:
                raise ValueError("SYMBOL_MISSING")
            result = callers(root, args.scope, args.symbol)
        elif args.command == "callees":
            if not args.symbol:
                raise ValueError("SYMBOL_MISSING")
            result = callees(root, args.scope, args.symbol)
        else:
            result = class_hierarchy(root, args.scope, args.glob)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except SyntaxError as error:
        print(json.dumps({"schema": "PYTHON_AST_ERROR_V1", "error": "syntax_error", "line": error.lineno, "message": error.msg}, ensure_ascii=False))
        return 2
    except Exception as error:  # fail closed with bounded structured error
        print(json.dumps({"schema": "PYTHON_AST_ERROR_V1", "error": type(error).__name__, "message": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
