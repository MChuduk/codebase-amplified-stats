/**
 * How a repository is named, whichever host it lives on.
 *
 * Adding a host means adding to `ProviderId` and to the registry it keys; TypeScript then
 * points at every place that has to learn about it.
 */

export type ProviderId = 'github';

export interface RepoRef {
  provider: ProviderId;
  /** May contain slashes: GitLab groups nest. Providers must encode it for their URLs. */
  owner: string;
  repo: string;
}

/** An entry from a host's Git tree listing, narrowed to the fields we use. */
export interface TreeEntry {
  path: string;
  /** Git file mode: `100644`, `100755`, `120000` (symlink), `160000` (submodule). */
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** Present for blobs only. */
  size?: number;
}
