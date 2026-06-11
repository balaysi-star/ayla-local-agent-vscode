export interface GatewayToolResult {
  allowed: boolean;
  reason: string;
  action?: string;
  target?: string;
  command?: string;
}
