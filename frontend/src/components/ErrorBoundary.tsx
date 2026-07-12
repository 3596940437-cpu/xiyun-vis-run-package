import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面渲染失败', error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="runtime-error-state notranslate" translate="no">
        <h2>界面暂时无法显示</h2>
        <p>{this.state.error.message || '某个交互触发了异常。'}</p>
        <button type="button" onClick={() => window.location.reload()}>
          返回星云
        </button>
      </div>
    );
  }
}
