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
  /** `partial` holds the totals so far once the first files have been counted. */
  | {
      status: 'running';
      phase: AnalyzePhase;
      done: number;
      total: number;
      partial?: RepoStats;
    }
  | { status: 'stats'; stats: RepoStats; failures: number }
  | { status: 'error'; message: string; code?: ErrorCode; resetAt?: number };

export function useAnalysis(repo: RepoRef) {
  const [state, setState] = useState<AnalysisState>({ status: 'loading' });
  const portRef = useRef<Browser.runtime.Port | null>(null);

  const loadPreview = useCallback(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void sendRequest<RepoPreview>({ kind: 'preview', repo }).then((response) => {
      if (cancelled) return;
      if (!response.ok) {
        setState({
          status: 'error',
          message: response.error,
          code: response.code,
          resetAt: response.resetAt,
        });
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
            // Totals already shown must survive a progress tick, or the panel flickers
            // back to an empty bar between batches.
            setState((current) => ({
              status: 'running',
              phase: event.phase,
              done: event.done,
              total: event.total,
              partial: current.status === 'running' ? current.partial : undefined,
            }));
            break;
          case 'partial':
            setState({
              status: 'running',
              phase: 'counting',
              done: event.done,
              total: event.total,
              partial: event.stats,
            });
            break;
          case 'result':
            setState({ status: 'stats', stats: event.stats, failures: event.failures });
            port.disconnect();
            portRef.current = null;
            break;
          case 'error':
            setState({
              status: 'error',
              message: event.message,
              code: event.code,
              resetAt: event.resetAt,
            });
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
