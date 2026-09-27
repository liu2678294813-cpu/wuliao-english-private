import "./globals.css";

export const metadata = {
  title: "无聊英语 · 精读训练",
  description: "本地优先的考研英语精读、PDF 阅读与词汇学习平台。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
