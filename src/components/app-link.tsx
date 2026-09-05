import type { AnchorHTMLAttributes } from "react";
import { Link, useRouter } from "@tanstack/react-router";

type AppLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/** Shared views also render as standalone HTTP documents without a router. */
export function AppLink({ href, ...props }: AppLinkProps) {
  const router = useRouter({ warn: false });
  if (!router) return <a href={href} {...props} />;

  const url = new URL(href, "https://vaporstats.com");
  return (
    <Link
      to={url.pathname}
      search={Object.fromEntries(url.searchParams)}
      hash={url.hash.slice(1)}
      {...props}
    />
  );
}
