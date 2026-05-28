
declare module '@triton-one/yellowstone-grpc' {
  export default class Client {
    constructor(endpoint: string, token: string, options: Record<string, unknown>);
    subscribe(): Promise<any>;
    close(): void;
  }
}
