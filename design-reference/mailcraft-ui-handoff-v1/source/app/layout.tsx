import type { Metadata } from "next";
import "./globals.css";
import "./mailcraft.css";
import "./studio.css";

const description="Mailcraft giúp đội ngũ nhân sự và marketing nội bộ tạo email đẹp, đúng dữ liệu mà không cần biết HTML.";
const socialImage="https://email-operations-workspace.alta-softwar-9113.chatgpt.site/og.png";

export const metadata: Metadata={
  title:"Mailcraft — Email Creation Studio",
  description,
  icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"},
  openGraph:{title:"Mailcraft",description,images:[socialImage],type:"website"},
  twitter:{card:"summary_large_image",title:"Mailcraft",description,images:[socialImage]},
  other:{"codex-preview":"development"},
};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="vi"><body>{children}</body></html>}
