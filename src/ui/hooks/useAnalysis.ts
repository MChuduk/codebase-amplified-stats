import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ANALYZE_PORT,
  type AnalyzeEvent,
  type AnalyzePhase,
  type ErrorCode,
} from '../../messaging/messages';
import type { RepoRef } from '../../common';
import type { Browser } from 'wxt/browser';
import type { RepoStats } from '../../logic/interfaces';

export type AnalysisState =
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

const STARTING: AnalysisState = { status: 'running', phase: 'resolving', done: 0, total: 0 };

export function useAnalysis(repo: RepoRef) {
  const [state, setState] = useState<AnalysisState>(STARTING);
  const portRef = useRef<Browser.runtime.Port | null>(null);

  const run = useCallback(
    (force = false) => {
      portRef.current?.disconnect();

      const port = browser.runtime.connect({ name: ANALYZE_PORT });
      portRef.current = port;

      setState(STARTING);

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

  // Counting starts on its own: a repository page the user has opened is the whole
  // intent, and a cached commit answers from storage without downloading anything.
  useEffect(() => {
    run();
    return () => {
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [run]);

  return { state, run };
}
