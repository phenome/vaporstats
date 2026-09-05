# Gates: internal api rate limiting

OWNS: wrangler.jsonc, src/server.ts, scripts/check-rate-limit.ts, GATES.md, docs/adr/**

Scope: enforce per-IP rate limiting across all internal api endpoints via Cloudflare Workers rate limiting binding

- [x] G0: this ledger states outcomes that can fail
  CHECK: node "C:/Users/live/.agents/skills/unlazy/scripts/gate-lint.mjs" GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=9725b4c72c3b0e2ef8c230d841c5b288751eba176283c04524c2dd035df88b74; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=E:\vaporstats; path=228ff971c327/73 entries

- [x] G1: api rate limiting unit and behavior checks pass
  CHECK: bun scripts/check-rate-limit.ts
  EXPECT: rate limit checks passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1381cb6a31c33923dfa1a12b12a6203f28185c5f8d550648a412d70fbc4b366d; exit=0; EXPECT=matched; output-sha256=44b594b9dd74a18fdbac5dd48ec6a76ca25a8355c21daa25b4faca2646bf9ccc; output-bytes=25; shell=C:\WINDOWS\system32\cmd.exe; cwd=E:\vaporstats; path=228ff971c327/73 entries

- [x] G2: workspace typecheck passes
  CHECK: bun run check:types
  EXPECT: TYPECHECK OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=feddb94b7e03c8502a856008fb16cfd3433bd0e2750f6d91229acd7c3ce7339b; exit=0; EXPECT=matched; output-sha256=61fdff6c29acd46e8a09c10380d79e4fe041e16ababda7f0b3fc9b27bcc35da4; output-bytes=50; shell=C:\WINDOWS\system32\cmd.exe; cwd=E:\vaporstats; path=228ff971c327/73 entries
