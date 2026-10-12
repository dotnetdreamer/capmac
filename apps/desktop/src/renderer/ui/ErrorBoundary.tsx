import { Component, type ErrorInfo as ReactErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';
import { EmptyState } from './Feedback';

interface State {
  error: Error | null;
}

/** Keeps one broken pane from taking down the window; never shows a raw stack trace. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string; compact?: boolean }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ReactErrorInfo): void {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <EmptyState
        compact={this.props.compact}
        icon="bug"
        title={`${this.props.label} hit a problem`}
        actions={
          <>
            <Button onClick={() => this.setState({ error: null })}>Reload</Button>
            <Button variant="subtle" onClick={() => void navigator.clipboard.writeText(`${error.message}\n${error.stack ?? ''}`)}>
              Copy details
            </Button>
          </>
        }
      >
        This is a bug in CapMac Studio, not in your app. Reloading usually helps; the details help us fix it.
      </EmptyState>
    );
  }
}
