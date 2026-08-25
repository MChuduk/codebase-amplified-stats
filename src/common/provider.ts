import type { ProviderId, RepoRef, TreeEntry } from './repo';

/**
 * What a code host has to provide for the counting engine to work against it.
 *
 * This interface deliberately describes only what an implementation actually needs today:
 * guessing at what GitLab or Bitbucket might want would produce an abstraction fitted to
 * nothing. Widen it when a second host arrives and shows what is really different.
 */

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  resetAt: number;
}

export interface RepoInfo {
  defaultBranch: string;
  /** Null where the host does not report a size; the panel then offers no estimate. */
  sizeKb: number | null;
}

export interface TreeResult {
  entries: TreeEntry[];
  /** The listing was capped by the host, so any total computed from it is a lower bound. */
  truncated: boolean;
}

/** Where to fetch the repository archive, and with what. Hosts differ on both. */
export interface ArchiveRequest {
  url: string;
  headers: Record<string, string>;
}

export interface DeviceCode {
  /** Shown to the user to enter on the host's site. */
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  /** Seconds until this code expires. */
  expiresIn: number;
  /** Minimum seconds between polls, as dictated by the host. */
  interval: number;
}

export interface Account {
  login: string;
  /** Null where the host does not publish one, or the profile has no picture. */
  avatarUrl: string | null;
}

/**
 * `invalid` and `network` stay separate because callers discard the token on `invalid`.
 * Collapsing them would sign the user out every time their connection blinked.
 */
export type TokenCheck = Account | 'invalid' | 'network';

export interface AuthProvider {
  /** A host offering only pasted tokens would add its own kind alongside this one. */
  readonly kind: 'device-flow';
  isConfigured(): boolean;
  requestDeviceCode(): Promise<DeviceCode>;
  pollForToken(device: DeviceCode, options?: { signal?: AbortSignal }): Promise<string>;
  verifyToken(token: string): Promise<TokenCheck>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly auth: AuthProvider;

  parseRepoUrl(url: URL): RepoRef | null;
  /** True only where the host renders the sidebar the panel mounts into. */
  isRepoHomePage(url: URL): boolean;

  fetchRepoInfo(repo: RepoRef, token: string): Promise<RepoInfo>;
  fetchCommitSha(repo: RepoRef, ref: string, token: string): Promise<string>;
  fetchTree(repo: RepoRef, commitSha: string, token: string): Promise<TreeResult>;
  archiveRequest(repo: RepoRef, commitSha: string, token: string): ArchiveRequest;

  /** From the last response's headers, so the panel costs no extra request. */
  lastRateLimit(): RateLimit | null;
}
