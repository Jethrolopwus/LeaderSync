// Minimal type stub for @triton-one/yellowstone-grpc
// The real package is loaded dynamically at runtime (with RPC fallback if absent).
declare module '@triton-one/yellowstone-grpc' {
  export default class Client {
    constructor(endpoint: string, token: string, options: Record<string, unknown>);
    subscribe(): Promise<any>;
    close(): void;
  }
}
