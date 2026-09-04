import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NavBar } from "./components/NavBar";
import { IntroAnimation } from "./components/IntroAnimation";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Revenue Recovery",
  description: "AI-powered recovery for failed payments",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        className="min-h-full text-neutral-900 flex flex-col font-sans"
        style={{ backgroundColor: '#FCFCFA' }}
      >
        {/* Cinematic intro — runs once per browser session */}
        <IntroAnimation />

        <NavBar />
        {children}
      </body>
    </html>
  );
}
