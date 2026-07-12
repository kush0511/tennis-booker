import type { Metadata, Viewport } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ||
    (host?.startsWith("localhost") ? "http" : "https");
  const metadataBase = host ? new URL(`${protocol}://${host}`) : undefined;
  const description =
    "Live Dooremi tennis availability, safe multi-session booking, and precise release scheduling.";

  return {
    metadataBase,
    title: {
      default: "Court Signal",
      template: "%s · Court Signal",
    },
    description,
    applicationName: "Court Signal",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Court Signal",
    },
    openGraph: {
      type: "website",
      title: "Court Signal",
      description,
      images: [
        {
          url: "/og.png",
          width: 1200,
          height: 630,
          alt: "Court Signal — your booking window, under control.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Court Signal",
      description,
      images: ["/og.png"],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#071d16",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${spaceGrotesk.variable}`}>
        {children}
      </body>
    </html>
  );
}
