export interface CodexAccount {
  id: string;
  email: string;
  /** User-owned display label; never participates in routing or identity checks. */
  alias?: string;
  plan?: string;
  chatgptAccountId?: string;
  logLabel?: string;
  isMain: boolean;
}

export interface CodexAccountCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  chatgptAccountId: string;
}

export interface CodexAccountCredentialRecord {
  credential?: CodexAccountCredentials;
  generation: number;
  refreshGrantFingerprint?: string;
  deletedAt?: number;
  replacedAt?: number;
  lastCodexValidatedAt?: number;
  lastCodexValidationStatus?: "ok" | "failed";
  lastCodexValidationError?: string;
}
