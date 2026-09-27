import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 只记录到控制台，不清理任何用户数据。
    console.error("App render error:", error, info);
  }

  handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const showReset = typeof this.props.onReset === "function";
    return (
      <div className="app-error-fallback" role="alert">
        <h2>页面遇到问题</h2>
        <p>请先重试返回首页。重新加载不会主动清除存档，但尚未保存的内容可能无法恢复。</p>
        <div className="app-error-actions">
          {showReset && (
            <button type="button" className="primary-button" onClick={this.handleReset}>
              返回首页
            </button>
          )}
          <button type="button" className="secondary-button" onClick={this.handleReload}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
