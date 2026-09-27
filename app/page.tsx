"use client";

import dynamic from "next/dynamic";
import "../src/readableStreamCompat";

const App = dynamic(() => import("../src/App"), {
  ssr: false,
  loading: () => (
    <div className="account-gate">
      <div className="account-card">
        <span className="account-mark">无</span>
        <strong>正在读取本机账号…</strong>
      </div>
    </div>
  ),
});

export default function Page() {
  return <App />;
}
