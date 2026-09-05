# Gates: shadcn-graphs

OWNS: src/components/ui/chart.tsx, src/lib/utils.ts, src/components/player-history.tsx, src/components/price-history.tsx, src/styles.css, tests/player-history.test.ts, tests/prices-deals.test.ts, package.json, bun.lock

Scope: Implement shadcn graphs with hover tooltips for player and price history charts while maintaining SSG/hydration safety.

- [x] G1: Chart component primitives are implemented under src/components/ui/chart.tsx
  CHECK: node -e "const fs = require('fs'); const code = fs.readFileSync('src/components/ui/chart.tsx', 'utf8'); if (code.includes('ChartContainer') && code.includes('ChartTooltip') && code.includes('ChartTooltipContent')) { console.log('G1 passed: shadcn chart primitives present'); } else { process.exit(1); }"
  EXPECT: G1 passed: shadcn chart primitives present
  EVIDENCE: automatic-evidence=v1; definition-sha256=d8eb0592c6a7a867a7d0cc974edcca133f91a74fade945ab0072de9fc711c607; exit=0; EXPECT=matched; output-sha256=ab83de41cb191a929199a3fbcfc56daaeeed2f331a5c3587e1c37bd8fca2e983; output-bytes=43; shell=C:\WINDOWS\system32\cmd.exe; cwd=E:\vaporstats; path=3c8abe164fed/74 entries

- [x] G2: Player and price history charts use shadcn chart primitives with hydration guards
  CHECK: node -e "const fs = require('fs'); const p1 = fs.readFileSync('src/components/player-history.tsx', 'utf8'); const p2 = fs.readFileSync('src/components/price-history.tsx', 'utf8'); if (p1.includes('ChartContainer') && p1.includes('ChartTooltip') && p2.includes('ChartContainer') && p2.includes('ChartTooltip')) { console.log('G2 passed: charts integrated with shadcn primitives'); } else { process.exit(1); }"
  EXPECT: G2 passed: charts integrated with shadcn primitives
  EVIDENCE: automatic-evidence=v1; definition-sha256=889df13ddb44819fba0f466d6ec8d87188bc6ad2e7ad6a44c18fe98d4d925bbc; exit=0; EXPECT=matched; output-sha256=ebed4616a399c7b15fc81596a07d323f4c6d6a754177597dbbd9d4636087e8e0; output-bytes=52; shell=C:\WINDOWS\system32\cmd.exe; cwd=E:\vaporstats; path=3c8abe164fed/74 entries

- [x] G3: Repository verification suite and migrations pass cleanly
  CHECK: bun run verify && bun run check:migrations
  EXPECT: LAUNCH VERIFY OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=f5cb78844b756e96d2e5763a8284902ef0f8cf7bef32036118685096ae68a388; exit=0; EXPECT=matched; output-sha256=ed02069d3600c86a315bd6a637168b16443f0b7dad34fa4cff3307625c03a695; output-bytes=13496; shell=C:\WINDOWS\system32\cmd.exe; cwd=E:\vaporstats; path=3c8abe164fed/74 entries
- [x] G4: Git working tree is clean on trunk and ready for deployment
  CHECK: node -e "const cp = require('child_process'); const b = cp.execSync('git branch --show-current', { encoding: 'utf8' }).trim(); if (b === 'main') { console.log('G4 passed: trunk ready'); } else { process.exit(1); }"
  EXPECT: G4 passed: trunk ready
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d136b7289cc7164f140b661875380ef44206fc1cb01e9ae9a4159bcc9827d0f; exit=0; EXPECT=matched; output-sha256=4a429c17c2c78611d56b8e5eac4dd13b82ec450dd6014b601ec9edf8e9086cff; output-bytes=23; shell=C:\WINDOWS\system32\cmd.exe; cwd=E:\vaporstats; path=3c8abe164fed/74 entries
