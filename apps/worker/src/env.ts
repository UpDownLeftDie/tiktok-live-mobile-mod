export interface Env {
  STREAM_SESSION: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  ASSETS: Fetcher;
  RELAY_SECRET: string;
  MOD_PASSCODE?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}
