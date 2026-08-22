import type { Provider } from '../../common';
import { archiveRequest, fetchCommitSha, fetchRepoInfo, fetchTree, lastRateLimit } from './api';
import { isConfigured, pollForToken, requestDeviceCode, verifyToken } from './auth';
import { isRepoHomePage, parseRepoUrl } from './url';

export const github: Provider = {
  id: 'github',
  label: 'GitHub',

  auth: { kind: 'device-flow', isConfigured, requestDeviceCode, pollForToken, verifyToken },

  parseRepoUrl,
  isRepoHomePage,
  fetchRepoInfo,
  fetchCommitSha,
  fetchTree,
  archiveRequest,
  lastRateLimit,
};
