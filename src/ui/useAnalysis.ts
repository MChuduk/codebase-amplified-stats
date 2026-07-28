import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ANALYZE_PORT,
  sendRequest,
  type AnalyzeEvent,
  type AnalyzePhase,
  type ErrorCode,
  type RepoPreview,
} from '../core/messages';
import type { Browser } from 'wxt/browser';
import type { RepoRef, RepoStats } from '../core/types';

export type AnalysisState =
  | { status: 'loading' }
  | { status: 'preview'; preview: RepoPreview }
  | { status: 'running'; phase: AnalyzePhase; done: number; total: number }
  | { status: 'stats'; stats: RepoStats; failures: number }
  | { status: 'error'; message: string; code?: ErrorCode };

/**
 * Drives one repository's analysis: previews on mount, then runs the count on demand
 * over a port so progress streams in.
 */
export function useAnalysis(repo: RepoRef) {
  const [state, setState] = useState<AnalysisState>({ status: 'loading' });
  const portRef = useRef<Browser.runtime.Port | null>(null);

  const loadPreview = useCallback(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void sendRequest<RepoPreview>({ kind: 'preview', repo }).then((response) => {
      if (cancelled) return;
      if (!response.ok) {
        setState({ status: 'error', message: response.error, code: response.code });
        return;
      }
      // A cached result for the current commit means there is nothing to ask about.
      if (response.data.cached) {
        setState({ status: 'stats', stats: response.data.cached, failures: 0 });
      } else {
        setState({ status: 'preview', preview: response.data });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [repo.owner, repo.repo]);

  useEffect(() => {
    const cancel = loadPreview();
    return () => {
      cancel();
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [loadPreview]);

  const run = useCallback(
    (force = false) => {
      portRef.current?.disconnect();

      const port = browser.runtime.connect({ name: ANALYZE_PORT });
      portRef.current = port;

      setState({ status: 'running', phase: 'resolving', done: 0, total: 0 });

      port.onMessage.addListener((message: unknown) => {
        const event = message as AnalyzeEvent;
        switch (event.kind) {
          case 'progress':
            setState({
              status: 'running',
              phase: event.phase,
              done: event.done,
              total: event.total,
            });
            break;
          case 'result':
            setState({ status: 'stats', stats: event.stats, failures: event.failures });
            port.disconnect();
            portRef.current = null;
            break;
          case 'error':
            setState({ status: 'error', message: event.message, code: event.code });
            port.disconnect();
            portRef.current = null;
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null;
      });

      port.postMessage({ kind: 'analyze', repo, force });
    },
    [repo.owner, repo.repo],
  );

  return { state, run, reload: loadPreview };
}
