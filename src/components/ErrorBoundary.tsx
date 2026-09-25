import { Component, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './ui';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="fatal-error" role="alert">
      <span className="fatal-brand">Agent Ops</span><h1>화면을 표시하지 못했습니다</h1>
      <p>페이지를 새로고침해 작업 공간을 다시 불러오세요.</p>
      <Button variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>화면 다시 불러오기</Button>
    </div>;
    return this.props.children;
  }
}
