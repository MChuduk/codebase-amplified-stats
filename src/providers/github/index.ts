import type { Provider } from '../../common';
import { archiveRequest, fetchCommitSha, fetchRepoInfo, fetchTree, lastRateLimit } from './api';
import { isConfigured, pollForToken, requestDeviceCode, verifyToken } from './auth';
import { parseRepoUrl } from './url';

export const github: Provider = {
  id: 'github',
  label: 'GitHub',

  auth: { kind: 'device-flow', isConfigured, requestDeviceCode, pollForToken, verifyToken },

  parseRepoUrl,
  fetchRepoInfo,
  fetchCommitSha,
  fetchTree,
  archiveRequest,
  lastRateLimit,
};
