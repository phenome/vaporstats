# Media observations for editorial follow-up

This living record collects specific questions about outlet evidence. Open entries do not block ingestion or require editorial sign-off. Each entry can be amended with a source and a decision.

| Game and evidence | Open question | Decision |
|---|---|---|
| Baldur’s Gate 3, source 1, private Overview 12 | Does the article establish a single-player mode, or describe how the writer played the Early Access version? | Open |
| Cyberpunk 2077, private Overview 13 | Which bug observations explicitly identify the platform or launch version? | Open |
| Hades II, private Overview 10 | Which article supports each item in the opening equipment list? | Open |

The [private-run evaluation](2026-11-25-media-publication.md) identifies the evaluated outputs. Ingestion may retain independently supported claims and omit unsupported ones. An existing extraction can be reused when it preserves the necessary evidence and scope. The first publication candidates are subject to the same evidence rules as future ingestions.

During an explicit refresh, keep one entry per source observation and question while its evidence is unchanged. Preserve human wording and decisions. An amendment identifies the source and the interpretation it supports. Revisit the decision when the relevant source evidence changes. Editing this document alone triggers neither paid processing nor publication.

Run `bun scripts/refresh-media-editorial.ts <private-sqlite-path>` from the repository to add questions recorded during extraction and synthesis. The refresh opens the database read-only and preserves existing entries, including those from earlier source versions. An optional second argument selects a different Markdown file.

Keep the generated HTML comment markers when editing an entry. Between the `media-amendment` and `/media-amendment` comments, enter the exact replacement observation wording with any required qualification, or enter `Omit: <reason>` to suppress the observation. Leave the block empty while the question is open. All questions for that evidence version and observation share one amendment. The deployed server reads the copy of this document included in its build.

## Questions from stored media evidence

<!-- media-follow-up 05a74710b7363ba0be0039324b7c98ad512a5dbe4136b12ed45684c0696c1e76 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Single\-player
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-1

<!-- media-amendment c84bd2d32595bbe5b6a35ac8073349c15f90c3aaa9a0ebcaaf411e5c0278b32b -->
<!-- /media-amendment -->

<!-- media-follow-up ff62da3cf3dc38b9e4baf679def3278942bb97131a1f26774ece0721415e8d26 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Turn\-based combat
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-2

<!-- media-amendment bdb12bd108d697d91c99b16cb33e35f364752556f63c1504e9046522483cdcbd -->
<!-- /media-amendment -->

<!-- media-follow-up 5497a24fed861ad3888bbaa3bc0c9478b6ef55287aaece630fb876700586d8ce -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Dungeons \& Dragons 5th Edition rules basis
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-3

<!-- media-amendment 7157dad9bb37b9f70d7f7070bab8f98c01dd588c310431d2343083fadf6e008c -->
<!-- /media-amendment -->

<!-- media-follow-up 05011104facb2bc739e0f642fbb0331da57c7802778b9a97250ea209928ba4be -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Environmental interaction in combat and puzzles
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-4

<!-- media-amendment 10bc2600dbc047a589d80ed99c2d96746fd2353ec9a5b618dc82f573115d9464 -->
<!-- /media-amendment -->

<!-- media-follow-up 18df0d25b4bb1f6542ab177feaffc9e47b0713a0128b1632e2eb6621f1a7963e -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Improvisational actions resolved with dice rolls
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-5

<!-- media-amendment 639dc35dc53ce970ab83100bbd77547c83231092b03a7fcf381303a594fd36bd -->
<!-- /media-amendment -->

<!-- media-follow-up cf9fd96f5eaf750493775ff3d7a8d39485e50953409ff5ddcc0015c1f98edae3 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Spells with non\-combat utility uses
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-6

<!-- media-amendment c31203a357274fa05d3fa25e3bd7213e5a758752a498634d4a673486eaa47272 -->
<!-- /media-amendment -->

<!-- media-follow-up f711b994a799a88302e287780af6ebed7e98affa6d961cd815fedb6647d86094 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Six playable classes in Early Access
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-7

<!-- media-amendment 4a7a051f04333bab9730502ddbe8cb71722da51b83c329beaeea949d6575cec5 -->
<!-- /media-amendment -->

<!-- media-follow-up c5fbf0285d5d542c9eefca3c493cadef475d9656169943f609c763acf16c9e41 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Extensive playable races
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-8

<!-- media-amendment a479a8eb82cdcc86a57497af25327ac070ec82820932db8fbb40a8fd45537de0 -->
<!-- /media-amendment -->

<!-- media-follow-up 57d05af73354796e040df8a29ca1102777693023a85c4864a492b514885385a6 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Set in Faerûn
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-9

<!-- media-amendment 544cee7ca23aeaaf309d7618d73c3154e9e5e4f5c2cd57dc696d529949681290 -->
<!-- /media-amendment -->

<!-- media-follow-up 3926d307b7daf7a4e20dd455a8e2a93d443593b432cbc4399375e2fdf7b0ec66 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: NPCs react to player character background
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-10

<!-- media-amendment aa5ebb53f78e3b73b14ad7acb5a19cfe88e504db32b2cf1798756d0a4dd09078 -->
<!-- /media-amendment -->

<!-- media-follow-up 93d0da52d89098533fb19672c6ff5646728a9c0fa35cb89720a0e547ed2a6d79 -->
- **Baldur\'s Gate 3** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Recorded wording: Action\-heavy opening hour
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-tag\-11

<!-- media-amendment 336ef12e1200ba5d00e10c3085798200de6d86ef534fd887d50a1a6257bda2a9 -->
<!-- /media-amendment -->

<!-- media-follow-up ea432ebb87570b04d69c8d54c64ddde2b4e34435f18d36e839adbc4764aebd6d -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? claim exceeds the display limit or uses source\-support language\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-3

<!-- media-amendment 6da7bcc5ec9cb8cb921cb8ea92150ce4430b08f5d1c47de4e9df961e0f516b31 -->
<!-- /media-amendment -->

<!-- media-follow-up 1b7acffd538e65fafcc033282b758b74701be2e5a2bde46f10b119d9ae60a9d5 -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? claim exceeds the display limit or uses source\-support language\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-8

<!-- media-amendment fd72c4c0601b7e00c09b94447b7ee27e8430058720f38ba5c4613203db232d22 -->
<!-- /media-amendment -->

<!-- media-follow-up 2483267a47276874310fbce540ef50b452cf1523f044031e50cbbe737a0a8660 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: The game structure allows for immense player choice in narrative outcomes\, character builds\, and mission approaches\, with side quests offering significant\, long\-term impacts on the main story\.
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-1

<!-- media-amendment 18094c892afd73fcec3eb6ed8077c89f61a65fca0fb2947aed0c10afa2ed1b08 -->
Optional quests could influence the ending in the reviewed PC version.
<!-- /media-amendment -->

<!-- media-follow-up 67e6ee5eb60c4fdcfaad18e86f521cab511882ff5099b70cf300b3b3a0655f9f -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: The main questline is surprisingly short but compelling\, anchored by the evolving\, confrontational relationship between the protagonist V and the psyche of Johnny Silverhand\.
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-2

<!-- media-amendment d7876f75b4dadbb26bd474aacc9acb81c04c93ec17b69c6b648f288c3261ce0d -->
<!-- /media-amendment -->

<!-- media-follow-up 6042b19065e86930416d0465061e1d337ff325549fd6016a9dd512ca966a67b3 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: Night City is dense\, diverse\, and visually stunning\, featuring intricate environmental details and a fantastic\, immersive soundtrack that drives the pace of combat\.
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-3

<!-- media-amendment 1a5341101ae1c08046453de1f8e876167274352aeccef03157b6af39ff22cce8 -->
<!-- /media-amendment -->

<!-- media-follow-up adfcd4f461ae7efe4ad41668d5512e32e425940e6305f6d806e2730ac7c8aed9 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: The game suffers from frequent\, distracting bugs including glitchy animations\, T\-posing\, missing models\, and overlapping dialogue\, despite running on high\-end hardware\.
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-4

<!-- media-amendment 9a83ddf08e1595bf90516584e4947db69cf53e9c1aed8c8fc4c35f26bf36cf7d -->
Broken character animations interrupted scenes in the reviewed PC version.
<!-- /media-amendment -->

<!-- media-follow-up 5fa2e73eb122c3feb78fd005141c224248ed15c14cc29c8a2ff993e0a6b43f67 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: Open\-world RPG
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-tag\-1

<!-- media-amendment 0fa4c260dff6bfbb3a00152f9db7a4955ba6c554286b8b055a5c1412a19b6c88 -->
<!-- /media-amendment -->

<!-- media-follow-up 1c0c0fff18b4fdcf49706518a86416660f6ca571803fe3f97c9b4e324dc78d07 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: First\-person perspective
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-tag\-2

<!-- media-amendment 5bff22430cefa8073f0e929ae4bd0861b6fa3b6b10700d18002792dc0a73ea8a -->
<!-- /media-amendment -->

<!-- media-follow-up b184976994f5c686671c4d62865423ccc01e23587c9952a82793cc7ae3513dce -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: Flexible skill\-based progression
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-tag\-3

<!-- media-amendment a8e0c7f60cf867dca35c736bd3dc351f4abbf047886cd1ffbc388cb73d6d988d -->
<!-- /media-amendment -->

<!-- media-follow-up b3adbcda2ea68b6bd586aeb9bcc52c238d5220c5e5fae493c91782cb4b5c1150 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: Mission\-based quest structure
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-tag\-4

<!-- media-amendment 22ea824f6bac824ae465e35013f7e52e6070d14d6bd5b0580bd0f731b9ad20a7 -->
<!-- /media-amendment -->

<!-- media-follow-up 56567cde8b228a38a5d690a49c425c5ea12d0696f351863938ea17716426cc5f -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 PC Review](<https://pk.ign.com/cyberpunk-2077/228703/review/cyberpunk-2077-pc-review>)
  - Recorded wording: Choice\-driven narrative
  - Source version: 0c4b2cdec69d22d81113f11643d013b5171c862f0006aef1c511eb3adb2da60f
  - Observation: legacy\-tag\-5

<!-- media-amendment 1a13ddd9cb911e333ad6bc500e97fba555bf08da81db067ab430bc25b8a7a3d3 -->
<!-- /media-amendment -->

<!-- media-follow-up a87ea193cd95157ad1d1b222bef5b257ad2d65aef8af0ce5ec4d249c8d64dbcc -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Cyberpunk 2077 is driven by a core of characters wonderfully written and performed\, a story of genuine layer\, momentum and depth\.
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-1

<!-- media-amendment 877fb0ed4685c171fbdb995c8d2b157b0274f93ab041aa68fc387c911fae33f6 -->
In the reviewed PC version, the central cast stood out for its writing and performances.
<!-- /media-amendment -->

<!-- media-follow-up 53c28128b457418308dabb688f039ef133852b09d583d131bccc6f2c121cf261 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: The combat is fun\, fluid\, and chaotic\, though not full immersive sim stuff\.
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-2

<!-- media-amendment 4fcdde83cf7d33e6052ffcabf4d4855c15a9e2cba9d60d11fbbb25b5a539ed57 -->
Combat in the reviewed PC version felt fluid and enjoyable.
<!-- /media-amendment -->

<!-- media-follow-up 85c8ccff28fede36070354a576773e3aff23a924565912f35385268a23a12afd -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: The sounds are masterfully aligned\: humming neon\, buzzing flies\, whirring motors\, screeching horns\, yelling passers\-by\.
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-3

<!-- media-amendment 69c51d15a16279b154b87fde45ce3c672e8502bf8e7afd7c9687e0763c285593 -->
<!-- /media-amendment -->

<!-- media-follow-up 57c6e23a628db817f4bc0d5c1a0e7eb4eb094a4893a6159d09cf559cf8a75aeb -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: The world map is dreadful and lacks at\-a\-glance readability\, making it hard to plan exploration\.
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-4

<!-- media-amendment 6a5437aee3032434c5f555f5955eb7d873448e7dccbd328e6c15e08c3cd1178b -->
<!-- /media-amendment -->

<!-- media-follow-up bfda7aa091a134e8e3db72faf8a96b771be51a225c07bc48d8743391b9be6a47 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Recurring\, persistent bugs and animation glitches undermine scenes and break immersion\.
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-5

<!-- media-amendment 3f698764dbcd9b1953bbfdd4b2cf86c195e9b3e9c498a757c84b0abfa6f6595b -->
A recurring animation glitch interrupted dramatic scenes in the reviewed PC version.
<!-- /media-amendment -->

<!-- media-follow-up a6f0acb3dd73f8e35081c1492ae780502c49787992a80da77132a3cc5a30742f -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: The game systems are poorly signposted\, breadcrumbed\, and paced\, often blocking interesting mechanics behind massive requirements of time and XP\.
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-6

<!-- media-amendment 99e2bb70f004391a3210288982cf3c657bd2fd47d819c31ffc0cbd9084a65cd5 -->
<!-- /media-amendment -->

<!-- media-follow-up ea11850db4cd0e0a68bbfae8d86f2162a7946aeef9801d9c2e80f5ca8545f6c6 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Ambitious
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-tag\-1

<!-- media-amendment 0c3f19f6175a364bb696ed533cfaf5a78413beceb87e22c6fedce2a8ad82da39 -->
<!-- /media-amendment -->

<!-- media-follow-up 265cbf35556e5d8a536342bd52cb070d0229b20fdbd578951e6d59eaf5163cc0 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Atmospheric
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-tag\-2

<!-- media-amendment e6b9b481d2570ddc33cf022f79a8befde43e4d479b16fc4cde3e6f130a2e7399 -->
<!-- /media-amendment -->

<!-- media-follow-up edb2d9230ab178ac89e2a1d6421dd940996aed4469cbbf0114fe44c810c510ce -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Nuanced storytelling
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-tag\-3

<!-- media-amendment b0e6e2ac36d9e27572a5453cf5d30658ace47c4bf54c81dbc85366924b3e17ff -->
<!-- /media-amendment -->

<!-- media-follow-up 67d805cf49aeb518ab1c1594370ab69079ffe64f1a41bc42b3a4f2fabae9fcb4 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Hostile world design
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-tag\-4

<!-- media-amendment d5a2cbbc8f6a4b7f1380974d48b21e49e3922907c2449c9d240a9a3725400c64 -->
<!-- /media-amendment -->

<!-- media-follow-up 308d3342b8320ed753c6c1b8aa2733e84c45adf0f39114a2050b4dd787cb6368 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Buggy
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-tag\-5

<!-- media-amendment c3bc714279984b8664d747c6fd3cbed47ea418151abece821a2c727d3f7e30d0 -->
<!-- /media-amendment -->

<!-- media-follow-up fb378719e1d85e4c767f97d5d7204e74168c8c40f1f2d08836eccedd91797767 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review \- intoxicating potential\, half undermined\, half met](<https://www.eurogamer.net/cyberpunk-2077-review-intoxicating-potential-half-undermined-half-met>)
  - Recorded wording: Mechanically uneven
  - Source version: 0665ae514b13b4a19303b92fd4fab52fe8a6a937508d84604735f2ed4a48e7d0
  - Observation: legacy\-tag\-6

<!-- media-amendment f9bc69f12786bc73b2489c406fcd21cd9a012aad0895287d829efb2e859cab7b -->
<!-- /media-amendment -->

<!-- media-follow-up 365529031f4098db62b8001569ac483428a201d4c867454c709d4f9165a7660f -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review](<https://www.pcgamer.com/cyberpunk-2077-review/>)
  - Recorded wording: Open world action RPG
  - Source version: a42909cd601b6007e2c2d10bb8ee3278a4b50c3b362049f36012fa2b693a0a56
  - Observation: legacy\-tag\-1

<!-- media-amendment fe8b6ac52bcbb50d58865db08fcede0a09c761669a7e7eceb29c5279ed1d6fe0 -->
<!-- /media-amendment -->

<!-- media-follow-up b3a4634a3ea92a0496413437ed62c5f956e4ab0ffd86cdf39073be0272c31adb -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review](<https://www.pcgamer.com/cyberpunk-2077-review/>)
  - Recorded wording: Futuristic setting
  - Source version: a42909cd601b6007e2c2d10bb8ee3278a4b50c3b362049f36012fa2b693a0a56
  - Observation: legacy\-tag\-2

<!-- media-amendment 31a17f54a4dbab7273ed0c0c05d35da23957cf0be831e59f9099967bfdce7ea5 -->
<!-- /media-amendment -->

<!-- media-follow-up e3280612d91e16b43555312fcf9a8932d8d9c852c31226e5076865360795cd37 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review](<https://www.pcgamer.com/cyberpunk-2077-review/>)
  - Recorded wording: Narrative\-driven
  - Source version: a42909cd601b6007e2c2d10bb8ee3278a4b50c3b362049f36012fa2b693a0a56
  - Observation: legacy\-tag\-3

<!-- media-amendment 3d5b3aebe0b38ddcf9aceafd2bab8ab39819cde284a1ea1feddab797a8f15067 -->
<!-- /media-amendment -->

<!-- media-follow-up 6f15d82ac27db84b5c7e20fc7655e82114b0878d706d46cdb73b0c0e9255da7a -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 review](<https://www.pcgamer.com/cyberpunk-2077-review/>)
  - Recorded wording: Bug\-ridden at launch
  - Source version: a42909cd601b6007e2c2d10bb8ee3278a4b50c3b362049f36012fa2b693a0a56
  - Observation: legacy\-tag\-4

<!-- media-amendment d0f6c2873b2ec815ce5b5cae8cb9cf8d7360afea9590e0fbb51e2e199c845b03 -->
<!-- /media-amendment -->

<!-- media-follow-up d940494a143a52fd995ee6865ca92de8885ee6d063b64330fac6df04a78c5557 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: The reviewer describes first\-person combat as a high\-octane FPS\. Joy\-Con mouse\-style aiming made headshots easier than with a regular gamepad\, which the reviewer prefers\, though long sessions caused hand cramping\.
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-2

<!-- media-amendment c39250f7faa2dcfd1004a8503979f79b446c7186c18c36a6ab98f3d634aec170 -->
<!-- /media-amendment -->

<!-- media-follow-up ecbf3d5b664073f3708718722e8698f4865901e6d0dc070b8d1c59f262e71296 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Right\-stick aiming with motion fine\-tuning works as in other Switch titles\, while motion gestures for melee\, reload\, and healing often caused camera wobble\.
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-3

<!-- media-amendment f1ceb27dac175a9280e1af6ab6e56bd3a7ffc0070ba172250b3a5997bcd338e7 -->
<!-- /media-amendment -->

<!-- media-follow-up e56e2bdbaf65c344d18e090c17572eae4d0c62abc44c789b4155e2b62071a357 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: The Switch 2 port runs at 1080p docked and at 1080p or 720p in handheld\, in Quality or Performance mode\, with a 40fps cap\. The reviewer found framerate decent but with some dropped frames\, not as smooth as Tears of the Kingdom or Breath of the Wild\.
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-4

<!-- media-amendment 7aba926de420d916b5a2da7d768cd13347af8ef39a2311aa1168d8082509e464 -->
<!-- /media-amendment -->

<!-- media-follow-up e0534525428dbe1e396225ef1ea3d9d1cc290a9ae9e19270d4ddd24008816d2e -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: The reviewer praises the world as moody and dangerous\, saying it quickly makes the player feel part of its culture\, and says quest conversations have a cinematic quality while keeping the player in control\.
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-5

<!-- media-amendment 36cc23b0bf4fd77b6a3ebb27e11337d6582a19b9afe1edccc06aa56644635b5e -->
<!-- /media-amendment -->

<!-- media-follow-up 26488fa15eb1e1204d1d47788650e8856805025026b5569ac99c89bd604a3f66 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: First\-person shooter with RPG elements
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-tag\-1

<!-- media-amendment b93aca81e14ce758f7c55cab5f0746d80c4332e8aaac0af4257bf74b468be772 -->
<!-- /media-amendment -->

<!-- media-follow-up a377dd5dd6aa07775a8e03f4fbebe00e167e8653e351a67af09586300ff80fdd -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Set in the cyberpunk city of Night City
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-tag\-2

<!-- media-amendment b727fd3edf748b64e1e9c9b7333b0b3bcc95125d87efef850d314114818ae404 -->
<!-- /media-amendment -->

<!-- media-follow-up fc6b2515205ea1b3bc14c5dded09dbb1d500afbc5279bedebca8381d807484cf -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Includes Phantom Liberty DLC on Switch 2
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-tag\-3

<!-- media-amendment d5e3f4b3ea92eb16d76aa7b95b9d84639f651bf5c9e637cebd7a90aa42dfc155 -->
<!-- /media-amendment -->

<!-- media-follow-up c07e6eed06ee747d434fa1e8ebfd0c76d4349bd0973719e00f31c17128c047fd -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Offers motion\-controlled melee\, reload\, and heal actions
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-tag\-5

<!-- media-amendment b99aeaee814e7f281aac9a043114ff545d6f1ed3710a40f307bad46726de624d -->
<!-- /media-amendment -->

<!-- media-follow-up fb03ba2823bb12b01d290d80116af1bdc7b59e51ef32a81510b974be80880623 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Switch 2 version runs at a 40fps maximum
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-tag\-6

<!-- media-amendment 0c283f5a97ea7fa2c9126a01afdbe0fac6805823fcac21a6fe22ba9020beee70 -->
<!-- /media-amendment -->

<!-- media-follow-up 0bb1d0c758ad7c8daff4cf3ea88a66baf3a2506000db4721f3d37bf5fbab26d9 -->
- **Cyberpunk 2077** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Switch 2 version renders at 1080p docked and 1080p or 720p in handheld
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-tag\-7

<!-- media-amendment 07f6d4714ee969f59c35b4f38b1581c34c68692d1dbf9112acf9052057759dca -->
<!-- /media-amendment -->

<!-- media-follow-up 7b8541844326c9b4d1c470ec2903306f204fe8ee9ee303584fbbd97125e5321e -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: First\-person shooting combat
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-gameplay\-1

<!-- media-amendment d33cca122e581f992c6e3773daf598d886c0086b51bc5df20be6ed9005bc2236 -->
The Nintendo Switch 2 port features first-person shooting combat.
<!-- /media-amendment -->

<!-- media-follow-up 588e3bddad53919713d7150f9c08ede4479dff8c413122b06e9f47bc47e127c9 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Melee combat and reloading
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-gameplay\-2

<!-- media-amendment db395abee63cf954defd14efe89a13e9fecad3d5bf39ff590bd8538c134fbac2 -->
<!-- /media-amendment -->

<!-- media-follow-up c60c1314abbf7aea03717c653318dd34e8adb2acff4949d4801499eec1145138 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Role\-playing progression and quest\-driven play
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-gameplay\-3

<!-- media-amendment db196d61b3beb20ac466904089e38129e7b9835901c0b6e95b5c994b967494b4 -->
<!-- /media-amendment -->

<!-- media-follow-up 6a829e894bd46629ccbfaeb3422799e3f196ae86737023a4b598586718d72331 -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Dystopian cyberpunk city setting
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-storyWorld\-1

<!-- media-amendment 6de5ceea0939bf3d6a29a7480c9a371bae703d5775efd6c05c075a40468945df -->
<!-- /media-amendment -->

<!-- media-follow-up 4dc719c9e41eb6b542d2b1f30fd21b10b71eda96dc4bcbd29293431fcc78950f -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Neon\-lit\, gritty urban atmosphere
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-storyWorld\-2

<!-- media-amendment a05dcaada0313c24fe28b14eba2820aacf7f570ab70fe42657eb71ebeab6e081 -->
The Nintendo Switch 2 port depicts Night City as a neon-lit city with grimy streets.
<!-- /media-amendment -->

<!-- media-follow-up 616987b6d8a45a2da4f42aa058741e30ec6e149f96c8929860ba3f563480943a -->
- **Cyberpunk 2077** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Cyberpunk 2077 Nintendo Switch 2 Review Update \- IGN](<https://www.ign.com/articles/cyberpunk-2077-nintendo-switch-2-review-update>)
  - Recorded wording: Quest conversations integrated into open\-world play
  - Source version: fc4446e330690b34c059993b22172d45e58a09da3f36cce5d145b653976204e8
  - Observation: legacy\-storyWorld\-3

<!-- media-amendment be1309b3648dbded81ce29e54861a41297bd28b329b649a527ba058dd656b3b1 -->
Quest conversations in the Nintendo Switch 2 port unfold cinematically while the player stays in control.
<!-- /media-amendment -->

<!-- media-follow-up 0a3fadbc0cc31119f0d5770f64df4f261610b0c78f5c41b5a48debbd00bb5a6c -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Protagonist is Melinoë
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-1

<!-- media-amendment ad990a588de17e3942640a5f3638bd3e9bf69b1df3f628b2c7cd43ab9e15028f -->
<!-- /media-amendment -->

<!-- media-follow-up ca59cbce7b08947f7feec632be3bda54fd5e2d765071636e244f07eeb968ef64 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Standard weapon is a witch\'s staff
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-2

<!-- media-amendment 699753488be7f93aeffb741dd60a4f92f47d78e610b9644e1798c13d813039d9 -->
<!-- /media-amendment -->

<!-- media-follow-up 05428a99a46382a874663c6fdea89efa4f0f492d782e96bbe486bc919f99ca07 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Omega attacks use a Magick mana pool
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-3

<!-- media-amendment 419d31165a36554b671cbae21990e163135f00d3682ee87341d3127d3e5c83d2 -->
<!-- /media-amendment -->

<!-- media-follow-up 1a4767d25a9f61beb8ea623cd40d3f8456a020d108f685b292fd41296032ab55 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Magick refills between rooms
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-4

<!-- media-amendment 4e339ca5b5c3ae7d1c059bd83c6eeaee1f5743ff66525f39bb31f078ee9b0e0d -->
<!-- /media-amendment -->

<!-- media-follow-up b2c4464aa5feceb9623882995d2940907111251160b3e62ad1ff8381a150e2a6 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Room\-by\-room choice via door icons
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-5

<!-- media-amendment 736e9b4e93bf859aa47b5a98ee47f2af2e96210f7d6390748e515265d0f33a56 -->
<!-- /media-amendment -->

<!-- media-follow-up 386031b0f7c5d5399a66144d68c270613108a6caa821d62cfbe362d53ce53a97 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Hub is a witch\'s camp
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-6

<!-- media-amendment ece61782ceb62fcfb5c581fceb57099cb7b229564168eabacab15090975d7c96 -->
<!-- /media-amendment -->

<!-- media-follow-up f0a8b8b8d64a0773708574240934e92b8899a465b0d843aa6fdfdbf91b70e7f3 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Cumulative god upgrades
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-7

<!-- media-amendment 70431eec23f451cb134025698e71a43c7275618d59b1cc71c643f64b3641e336 -->
<!-- /media-amendment -->

<!-- media-follow-up 32a5971cbb408c4096a9560a69ef41aa2970666d9be87d35c04c8c5d028c15ec -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Tarot\-card upgrades
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-8

<!-- media-amendment 4e5e0d7719fd6f1fd61b185f47e5fcad26f9114957ee5cf2bd9655bd8fd1a23e -->
<!-- /media-amendment -->

<!-- media-follow-up f89d42146baeba82f69c90572730071d3478f92109fab71ed6bbed932d31b103 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Early Access launch
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-9

<!-- media-amendment d11ad90d52d3976c7cadfb3bd6bf6adc691323833aba089202da9b8994c0392f -->
<!-- /media-amendment -->

<!-- media-follow-up 0ab50f60ab5a577a3103003dbd0f62937efb530865d791e5479c362391333f29 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 early access review \- polish and terrifying power from some of the best out there](<https://www.eurogamer.net/hades-2-early-access-review>)
  - Recorded wording: Continuity with the original Hades art and UI
  - Source version: 87178b6cc82039cac6f514b5db7db97fc0725ec9def188d846eff3254f4e7751
  - Observation: legacy\-tag\-10

<!-- media-amendment a1cfc44d6dbf108f60a6da8be3be3e26c6446aded097df5cd3d674615633a885 -->
<!-- /media-amendment -->

<!-- media-follow-up 4efaee6526f776dccb2bf6d90e10ac67470d853b9e2ffd69b72ea291db5afc8b -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 Early Access Video Review](<https://sea.ign.com/hades-ii/233228/video/hades-2-early-access-video-review>)
  - Recorded wording: Roguelite
  - Source version: 557ea93c81e0dfdab8944d790a03bf89696d098d4d7bcc764615921075fd9108
  - Observation: legacy\-tag\-1

<!-- media-amendment 8463528d1d225cfdaf044db2f38882dba921dec13e83bb91ed97d1217432c38d -->
<!-- /media-amendment -->

<!-- media-follow-up f82b68f316541622a6ca119065eea0db16c6d1e9aa5b7754775735ca3ec3e6de -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 Early Access Video Review](<https://sea.ign.com/hades-ii/233228/video/hades-2-early-access-video-review>)
  - Recorded wording: Sequel
  - Source version: 557ea93c81e0dfdab8944d790a03bf89696d098d4d7bcc764615921075fd9108
  - Observation: legacy\-tag\-2

<!-- media-amendment b6b0b10de36c6a139756a9942e7aa68509a48c5838b5dc8d05af9d48a1d4f0a8 -->
<!-- /media-amendment -->

<!-- media-follow-up c0287ab369f4622c000aae8029859e98b3c4a02ca2bfda547984297ba73f2915 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 Early Access Video Review](<https://sea.ign.com/hades-ii/233228/video/hades-2-early-access-video-review>)
  - Recorded wording: Early Access
  - Source version: 557ea93c81e0dfdab8944d790a03bf89696d098d4d7bcc764615921075fd9108
  - Observation: legacy\-tag\-3

<!-- media-amendment b51df57e5159cd3461198c0a2dbc07266a35179b2a6c808ea41e0db5427943cd -->
<!-- /media-amendment -->

<!-- media-follow-up 98d0af0282d8c551f75d19aeba191a8b5710304d6f05f338313fd2e46a80e890 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 Early Access Video Review](<https://sea.ign.com/hades-ii/233228/video/hades-2-early-access-video-review>)
  - Recorded wording: Roguelite progression
  - Source version: 557ea93c81e0dfdab8944d790a03bf89696d098d4d7bcc764615921075fd9108
  - Observation: legacy\-tag\-4

<!-- media-amendment 8b42b9099e6f2f3d92cb2e6147ac372efa35d0d806f3f3fc73362ea6cdd862b1 -->
<!-- /media-amendment -->

<!-- media-follow-up 3503c9e073061659ad7a21457661aae53d512ab4a112c2e8637755d726a01538 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 Early Access Video Review](<https://sea.ign.com/hades-ii/233228/video/hades-2-early-access-video-review>)
  - Recorded wording: Surface levels
  - Source version: 557ea93c81e0dfdab8944d790a03bf89696d098d4d7bcc764615921075fd9108
  - Observation: legacy\-tag\-5

<!-- media-amendment 257df9fc6edb2aff47963a581513714fdccd8b2c1ad3c9b62b2d22ce4b0f4c84 -->
<!-- /media-amendment -->

<!-- media-follow-up 33ca12a949fa9ce12f2f2fce74231abcc4996292d10626771bd6418134127a58 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 Early Access Video Review](<https://sea.ign.com/hades-ii/233228/video/hades-2-early-access-video-review>)
  - Recorded wording: Underworld levels
  - Source version: 557ea93c81e0dfdab8944d790a03bf89696d098d4d7bcc764615921075fd9108
  - Observation: legacy\-tag\-6

<!-- media-amendment 3e0381c7b19a3ad7eb8f4310ec6080665944bb5dab138e0accb436fc0c2569ce -->
<!-- /media-amendment -->

<!-- media-follow-up 4637a4184f27fdb92778e2bc100ce68c6df76811293e11431a90d17d5dd41957 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 Early Access Video Review](<https://sea.ign.com/hades-ii/233228/video/hades-2-early-access-video-review>)
  - Recorded wording: Protagonist Melinoe
  - Source version: 557ea93c81e0dfdab8944d790a03bf89696d098d4d7bcc764615921075fd9108
  - Observation: legacy\-tag\-7

<!-- media-amendment d5e31138efe12e454c71f989f139f57a2d425eaa2b23b86fd215540d91ea3337 -->
<!-- /media-amendment -->

<!-- media-follow-up 5839367ba17d87a3c076aae3337ce37aea26eb2c1c3bacbde9e96db3c4f58012 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Describes the Surface as an endgame\-style set of areas\, set in the ruins of Ethyria and on a ship in the Rift of Thessaly\, with demanding combat and hazards\, which the reviewer contrasts with the Underworld\.
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-3

<!-- media-amendment 364efb8c14e18bab54f698cb1e29a2e2282d452fcbe08590e552449edea9849d -->
<!-- /media-amendment -->

<!-- media-follow-up 739b4203fac24aec72a80b2815689cdf60f4680d3c0dc838dcd83b7ed298bdf0 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Describes the cast\, including Hecate\, Nemesis\, Narcissus\, and Demeter\, and conversations unlocked during runs\, which the reviewer praises as a key part of the experience\.
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-4

<!-- media-amendment 045de7493845f2b1bdd601b026bf2673f8a472dbd59e200d89736a033ea18181 -->
<!-- /media-amendment -->

<!-- media-follow-up 4443ef2a3759584ae1cd03577596bc3dcee277e6bd715aefeb47419f2fcbf61f -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Reports that player choices\, such as strategy use\, can produce narrative consequences in later runs\.
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-5

<!-- media-amendment 9e9ed85c7b07123d4c70373732e2aab753de33059e14d7357346c69c52bd71b7 -->
<!-- /media-amendment -->

<!-- media-follow-up 3942f766ea90201f77cdc1a1ea5d34e05d3549389479082f2f86d4c1328b47a7 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Describes the Surface\'s visual shift from the Underworld and the soundtrack\'s move from guitar\-led music toward a heavy metal orchestral sound\.
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-6

<!-- media-amendment 605287b02f30cbdaa1d731fb74a21403b443bc684664f554bb968689fca8d604 -->
<!-- /media-amendment -->

<!-- media-follow-up 019bf0c5897247d9718d230f2979c228e5db199fe3ed443fb3e13b91ae26bf5d -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: 2D action game
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-1

<!-- media-amendment 8623bbe33492d9cb34e7a6ce0071429febd8829efb487afc576172d8514c3fed -->
<!-- /media-amendment -->

<!-- media-follow-up 5a04694167cc758b5dec2e12467a522b232e2160072f7a790bfc4d18b2163ef3 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Roguelike run structure with random upgrades and rewards
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-2

<!-- media-amendment c5a55393083fd84a84cc12a875125212127b567f2f9c712521cf1f563e6e7dab -->
<!-- /media-amendment -->

<!-- media-follow-up 294a1f09175625ff7eb6df697eb58e900399df3d9336248404c8bec0d3bc75bd -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Crafting\-based progression using reagents and Incantations
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-3

<!-- media-amendment 64b0b2e1c46d8281d051d91a67b7660544ccb4569d4a8378d541b9b361a52d62 -->
<!-- /media-amendment -->

<!-- media-follow-up 2b8388cedc59012ea8e209bd6acddaba51818fad895d3c4a74830eb87591ad84 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Magic\-infused normal attacks for the protagonist
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-4

<!-- media-amendment fb67458c783eea576567b983b0592b4d9beac54c8cbe69aa6f6ecf006a209e60 -->
<!-- /media-amendment -->

<!-- media-follow-up 8cc0b98d27b33403033241b720e887f2126c25b811a2ef1498d0e12e5f16ef10 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Multiple weapons\, Arcana Cards\, Keepsakes\, and familiars chosen before runs
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-5

<!-- media-amendment b5a4947a9f35f5be9f1ccc7d39328fa970eb1bafb911bb08de4a71c7bb8435b1 -->
<!-- /media-amendment -->

<!-- media-follow-up 111c329bacd5700d2803a89face16cdbbce348ec25f2aa46f0f57e48190ab3ae -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Surface areas with soulslike\-level precision demands
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-6

<!-- media-amendment 459d5f222653f9203f352e53725ce661c7dea017e0497d646b6dfa731f02f646 -->
<!-- /media-amendment -->

<!-- media-follow-up 982cacce6f583c658c8df270017297e601021fd7285e3b3848c2bc9c19eb62be -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Greek mythology setting
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-7

<!-- media-amendment 05d5502f5252cdb4aa6915d8661cba3c94fada807af32f532f407dff12b962c2 -->
<!-- /media-amendment -->

<!-- media-follow-up e1d3f91ba7c4ce39a0706e47afcf8271ae2cfe8bc5f13a2e45324d8dd2710d4c -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Character conversations unlocked during runs
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-8

<!-- media-amendment b5a1bb2bf83ce020a5ff53d5e412793533f7f5e7512fea350b25ed2ebb3acdbc -->
<!-- /media-amendment -->

<!-- media-follow-up cf09d2349bf9eff0f3914899019748ec793b0928860440dac948300b17aa1e2f -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Narrative consequences for player actions
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-tag\-9

<!-- media-amendment 1cc81c087b1b4713ba33b51879576daa0aa3e6d9a9da8d05b698bc756e653dcd -->
<!-- /media-amendment -->

<!-- media-follow-up 8268325f5fc8601f65d42bde945c419db1047cdb6d7fed82df0cf95f90c7fb31 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Combinable weapon\, magic\, and boon builds
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-gameplay\-1

<!-- media-amendment 89f787d4313d318ca43f37254463c0a998a991a8595cd46241d1388d445abcf9 -->
<!-- /media-amendment -->

<!-- media-follow-up f1711c27cdcbdff3ef89af884fd5744026548af588cb4a58253c9817e8e48584 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Crafting reagents into Incantations to unlock hub features and progression
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-gameplay\-2

<!-- media-amendment 76e7968e41d0e69f5e16447d3b8f448f33866136020263ae2909ad65b6da650d -->
<!-- /media-amendment -->

<!-- media-follow-up 9179199f5a640c7a878f1f028bc0ab34522f6aefd0715ba828df87583ff5e30d -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Endgame\-style Surface areas with dense combat hazards
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-gameplay\-3

<!-- media-amendment 912b01852b4b01313afb2c15de860667aa1808d5e459f6ac01590533d38c6919 -->
<!-- /media-amendment -->

<!-- media-follow-up 5d78024f7390319ab185541394163a2b36c87d4355ed2e2a0165c6b3337f7ac5 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Passive bonuses from Arcana Cards and Keepsakes
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-gameplay\-4

<!-- media-amendment ebcdb1023da1cdab11e8c1932268d7776dfe1965de3b87f6ad9189b6850f5358 -->
<!-- /media-amendment -->

<!-- media-follow-up 7150c3edf6f57daf8d9d971633a1abd9767147d14ab755c2c86f861232c56563 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Room\-based combat with random upgrade and reward selection
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-gameplay\-5

<!-- media-amendment 12e1b827a7a08a6171740a880d27c97fde6eac74d7d9ff73737eaa600333a142 -->
<!-- /media-amendment -->

<!-- media-follow-up 0b9dd061fad1f1e8b6de3d9c620a306fb3fbfb73daff91bdb6f5c605caf98ac1 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Character conversations unlocked during runs
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-storyWorld\-1

<!-- media-amendment 0ee0a46e954e85eb8fb24890bb6e68f0092872f7fe886bb5b3f5902c42b85ad7 -->
<!-- /media-amendment -->

<!-- media-follow-up 602c68a75535fe2335a1c4a38f0afbc0e52d300d265490ab724b9880cede0304 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Narrative consequences tied to player decisions
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-storyWorld\-2

<!-- media-amendment 08711fd5a98f9960736a91385dbbcd191cca78689732c89876d5a46f03fa1462 -->
<!-- /media-amendment -->

<!-- media-follow-up 18b1c3162ce1e5d27801605fad74132d107a1b882a8bd1c7caf30583c574b185 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Recorded wording: Reimagined Greek mythology setting
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-storyWorld\-3

<!-- media-amendment 8e1b8dd77bb8f7a6b5792951bfa16c2190d082a099e783a63f2a1da5d9df1aff -->
<!-- /media-amendment -->

<!-- media-follow-up 711642c35ba0ff186c4061c0238366fca546730fd4c23632c8710e771e40e0e1 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Describes Melinoë\'s combat as more considered and cerebral than Zagreus\'s\, built around a Tarot\-style spell system\, Omega charge attacks powered by a mana meter\, and build\-crafting through god boons\, weapon upgrades\, and Hexes\.
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-1

<!-- media-amendment 44cd34cee05798b393e194534914bc67d786e1326d6aeae929719132867fcfba -->
<!-- /media-amendment -->

<!-- media-follow-up 97efaed6ddca94412c948071ca61bd89c1f6d7fc2aed7e563f5c0bdb68c3317d -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Describes two distinct branching paths\, the descent toward Chronos and the ascent to Mount Olympus\, each with its own bosses\, enemies\, storylines\, and specific boons\.
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-2

<!-- media-amendment 10253a87e2b1619c33f50943f9f7a725e7c00ec4501fd02dba56f1b39b711c10 -->
<!-- /media-amendment -->

<!-- media-follow-up a14ce34e9b79596191b4aebdcbe7ba63a8440977af1517a6144644ec585cd761 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Describes Melinoë as a young woman raised by Hecate\, whose fate is set and whose fight stems from necessity\, contrasting her with Zagreus\'s rebellious temperament\.
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-3

<!-- media-amendment f7d6c7b6d9d64ae7459e87697084635b9fe6f663764bd16a308f3bb3d01b1fe8 -->
<!-- /media-amendment -->

<!-- media-follow-up 9c4830583982ebc30ad8ba30d825e7fbac9e5e878009d20c9bc10753f125597a -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Describes the writing as a reinterpretation and retelling of Greek myth\, with a supporting cast drawn from Greek myth and a central narrative linking nearly every NPC interaction\.
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-4

<!-- media-amendment b7f5e340136b53136d7095707706bb0947e2dd376c5391eaea927c5e9a530a99 -->
<!-- /media-amendment -->

<!-- media-follow-up 9c26e26c7c3e554cc909dd7e84037521763555dc4e6265e052019fc195f8f57a -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Describes a musical boss fight and a soundtrack that changes when certain enemies are slain\, with a siren song that grows clearer as the player descends\.
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-5

<!-- media-amendment 2c3e5f7c5a01311c83470d039b4eb55da330df96d4a7ee32681971b4e69c886d -->
<!-- /media-amendment -->

<!-- media-follow-up 65d8afff195b0b6a82849aeac8e0fd5382c5f3c24dc8572fc2eea0787fa409db -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Roguelike action game
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-1

<!-- media-amendment 299660b4a0e2c9c925e6b11c116a3cbe6d624831367993cd5288b5ec3a7e4ead -->
<!-- /media-amendment -->

<!-- media-follow-up 6d683bb433a2da147bd14b0f8fd604cbb3a309558bbc0d06d7d2a68230944516 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Playable character Melinoë
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-2

<!-- media-amendment 9579039cd07afbef14392136b9ee43d4b7568951a76721d80b24d270b69f7b8c -->
<!-- /media-amendment -->

<!-- media-follow-up 162db730ad4ad9e183d203478400f5ac31f37a5cb91594e45a2c244a4ec7852a -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Omega charge attacks powered by a mana meter
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-3

<!-- media-amendment 7cf6c66156cbda7be069e573c9615f711c30dcd82e6b2fd0d360bdb598385d31 -->
<!-- /media-amendment -->

<!-- media-follow-up 17ca0133090e51a6010db132a7360c0e8e00c2e2187c4ed68e720c1b4a6909bf -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Tarot\-style spell system
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-4

<!-- media-amendment 3d9fda78b0088adced294720e4dfd33162c8ea0c9bbacbd7afa18507ac6fee98 -->
<!-- /media-amendment -->

<!-- media-follow-up df6e695c9e98bcb4a1b169cdd794e7ae7b36e28aff3e1e393bfea8a53947ce04 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Hex special moves
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-5

<!-- media-amendment 0e66bc72306dd9b51e0df3baa7b21a94416406385c0d97f2b69178d4f427babc -->
<!-- /media-amendment -->

<!-- media-follow-up 709efb9bb663287e50c55f181a76838ac2696f856216898cbc7c24c25720ae47 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: God boons that modify powers
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-6

<!-- media-amendment 7f495f75bcee7a2979147a833c6f3bc1d29b1c11da865ae23da87d642c401e0f -->
<!-- /media-amendment -->

<!-- media-follow-up 6ef3ce76be371e5ab11438bdd6b3db8d4354f4f0f13ad22e8615baf4d7e924b5 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Weapons that interact with boons and the cast
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-7

<!-- media-amendment 1237f93c8462e353f9d3cb0707304c8186e87cbddddf9dd98ac23c4d38b848b7 -->
<!-- /media-amendment -->

<!-- media-follow-up ef93b953e08eafe1b9fef8b5b11b813d69e41f0610c8424da76cd4bad8ef3afb -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Mana refills between rooms
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-8

<!-- media-amendment f36168d3763ccfbe8d9fa5778d3da864c26a6be3679942b3a38afe15de49f406 -->
<!-- /media-amendment -->

<!-- media-follow-up a9a90ccaf2d2cf8023e357d4efab6b02f589424bd802f35e9e31e1c33a3a18f8 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Two branching paths with separate bosses and enemies
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-9

<!-- media-amendment ee3fc42e66ab59c68a6bffa0e04d09a85d495dac196be820f192920fb3884d5b -->
<!-- /media-amendment -->

<!-- media-follow-up c85824b4ae947364f1b09176e193e4219abca67e3fa6b250590890c0aaa5ee7a -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Crossroads hub
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-10

<!-- media-amendment 800645312cbdcbef716171ad0adc33a05aa0885eea11b007ba4e54f5b75f8114 -->
<!-- /media-amendment -->

<!-- media-follow-up 631dfb7ea896b93057f1feb3a430eb76fbc05a2840543e628d7054117436e0e6 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Greek myth reinterpretation
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-11

<!-- media-amendment 0a268337a121be60f9817587b3dab35f880d4ee97728ddd15e1a476830d4419f -->
<!-- /media-amendment -->

<!-- media-follow-up 034f903bbcec016a350968cd803925df2ca4fbf40f22db318e5c9db6802cbdc9 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Chronos as the final antagonist
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-12

<!-- media-amendment 91ddd26105abb4818d7ed3ad1faab170990522aed1e5ccfce33645d024eb4b88 -->
<!-- /media-amendment -->

<!-- media-follow-up dc4bb295ace872b6b78ee56c4fe332f7cab2e1faf44bd6702853600377321dd5 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Musical boss fight
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-13

<!-- media-amendment 82a4e580bcad6f8f2e8b235575dea0b51944873f1af66dc6998506eb0c8f152e -->
<!-- /media-amendment -->

<!-- media-follow-up a6047ffa2668d4de9058779dfab158a9bb223b37a8553ede634b28969ba38814 -->
- **Hades II** — Does the article establish this characteristic at the scope of the discovery label\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Music changes based on slain enemies
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-tag\-14

<!-- media-amendment b0727e40c4aa6f874d63e77175e2bcfdf85d3582c5852beec097a7c2fb915fe7 -->
<!-- /media-amendment -->

<!-- media-follow-up aec9a8221697774859bad82b322dd9022af1fe3f38bda809504d2e2b08ef26e2 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Charge\-based Omega attacks supported by a metered mana resource
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-gameplay\-1

<!-- media-amendment 89be44f4aae3eab7f491b456883d2134e738e331f2c4401d91d9dd3341abbf79 -->
<!-- /media-amendment -->

<!-- media-follow-up 177715670e1636e0eb5a95de7f48081a6108486f533c951bdabe8ef673f4d776 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Hex special moves that can be added to builds
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-gameplay\-2

<!-- media-amendment edbf5e95d82938bcd9f23d73213797f1745c591b570004cd2aff2967152f29a6 -->
<!-- /media-amendment -->

<!-- media-follow-up 1844b74b0f0e6ef3ea69d0d24255ba2c7ae85beec7e3b17129c7e73052523f1d -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Mana replenishes between rooms
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-gameplay\-3

<!-- media-amendment bba721a78b3b9c29aed11e29f3c9fa881ea7fbae7d83c2897c15b489b2e12a12 -->
<!-- /media-amendment -->

<!-- media-follow-up 9b3ac1b01df7b0978c2111905945a0b1050f6e3a46094365f62204c8787ce097 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Roguelike runs with god boons that modify powers
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-gameplay\-4

<!-- media-amendment 2a1bf1b5f7cb623ab09accd329a96a010e6e7c6a231ce8a2ea2fca3776113e74 -->
<!-- /media-amendment -->

<!-- media-follow-up ddb551b86ede1e8e84bf92844f92803c4a909af69eb6ef31bd9a7f784e67dce2 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Tarot\-style spell system layered onto physical weapons
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-gameplay\-5

<!-- media-amendment 5405a48fd37180e67dec708fd3a9541cb98540e8d1e9a5bd3436847d601f7fa6 -->
<!-- /media-amendment -->

<!-- media-follow-up 358a64de4131d2fd568becef2b4abf64409c0942f450c921827f2d836079456e -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Two branching paths with separate bosses\, enemies\, and boons
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-gameplay\-6

<!-- media-amendment c066e2010827ce0b03d55a5e71f4803435fe1c5c2566ffc0db0c613ea4768ebe -->
<!-- /media-amendment -->

<!-- media-follow-up 5daabcb965ecbb3476f667b0451746303e8c4de9420efa6e7ec0e71d8a7fa64d -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Weapons that interact with boons and the cast ability
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-gameplay\-7

<!-- media-amendment 1c6320fb41aab76563abd340fcbe66fa20ea9e5094c0138afce57b1ea3bee60a -->
<!-- /media-amendment -->

<!-- media-follow-up f770dbb845e401a18ef672fccc8f0a8427dce76760ae52098671b90c16780c34 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Chronos\, the Titan of Time\, as the final antagonist
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-storyWorld\-1

<!-- media-amendment 28aecf0deccdfb7c6b7d0be078e1744c6deb160f2625f606c6070fae4e85fd79 -->
<!-- /media-amendment -->

<!-- media-follow-up 5e511fb390606b9ec8307d1761e9531a63bca384b29d457f78e6a09b9e3f148d -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Hub area where NPCs have interconnected side\-stories
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-storyWorld\-2

<!-- media-amendment 1e6349c2383b3ed4fe2555645ecda03d24c30c8b4a12501cbacbae9e53fe2b2c -->
<!-- /media-amendment -->

<!-- media-follow-up 291ce73a669ee1da9b5189e1965e47bdf8e0428e0b675cea786d129e83f01b9f -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Protagonist raised by Hecate
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-storyWorld\-3

<!-- media-amendment 77412ad833a406194f9e234adcfbfd3a0e2e1b886e108ecd07cb129d2bf0c4c7 -->
<!-- /media-amendment -->

<!-- media-follow-up de06f923bd799f6d794d88aee6b945ba3f5c2b49e6d010f1101bcc27aab6d773 -->
- **Hades II** — Which version or platform does this observation describe\, and does that qualification affect the claim\?
  - Source: [Hades 2 review \- standing on the shoulders of Supergiants](<https://www.eurogamer.net/hades-2-review>)
  - Recorded wording: Reinterpretation of Greek myth
  - Source version: e6c4c6c0e0eba2d8432439ba87ae3410461b1814cf4e25f1cfc8941213df058f
  - Observation: legacy\-storyWorld\-4

<!-- media-amendment 8d0aea9362828935bb8cc859b15b2241ed07c1e25229cf6654583985274abd98 -->
<!-- /media-amendment -->

<!-- media-follow-up 38c077809c749a9f0066609d58b4c72b96da9744c0c8f477ba3e3e402129c5d0 -->
- **Hades II** — What wording and scope does this observation support\? claim exceeds the display limit or uses source\-support language\.
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-1

<!-- media-amendment 07caf6e5f3cf7c1f8b593e41ab021e6c1376b8ec1c9cd9b8addda92fa80c2c3b -->
<!-- /media-amendment -->

<!-- media-follow-up 2198ede547592e57c7ff3d9e803668093a28dd28e185e6435f053d0bf1d448ea -->
- **Hades II** — What wording and scope does this observation support\? claim exceeds the display limit or uses source\-support language\.
  - Source: [Hades 2 review](<https://www.pcgamer.com/games/action/hades-2-review/>)
  - Source version: a1095043b2095635e3e80a9046437e662673ca630d539cf6afa75a3a0b33f41c
  - Observation: legacy\-2

<!-- media-amendment d53ae8566ded1877a2cd58c67f5a891d05722e9c19a6e9b25bf1745c6c9b40b2 -->
<!-- /media-amendment -->

<!-- media-follow-up 7d3c23fa6a45ade4ad379fa8123a72c335db1821b5ca57931e86d7e9524d0d26 -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-gameplay\-1

<!-- media-amendment 22631b012493a8ad4dda80da068023182f7b769925d57c5e135bb48abd223554 -->
<!-- /media-amendment -->

<!-- media-follow-up e7006af07e19b867f81c605ead7052413564c41c095c0f2035d857005bd72eff -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-gameplay\-2

<!-- media-amendment 91d775b41a392a5ba0fedd59f6048b4b652dfd8e4813aff671ae630eef1a6b32 -->
<!-- /media-amendment -->

<!-- media-follow-up 27490e8eccbe197464e3b3007da16c53704da0308c6c0f4012a7ef0f684f776e -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-gameplay\-3

<!-- media-amendment c41cea17530dc584fbdefbb1980d7777c489a63b12d801565f4f88653936b1cd -->
<!-- /media-amendment -->

<!-- media-follow-up 112aabceab0607f0e7cd3da7981a69902368b57529f470912383e47a70b8ea54 -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-gameplay\-4

<!-- media-amendment 39b65fdafa3e2a733ec960271865cfc2d659ec3020c6edb7bbac575284bf4d02 -->
<!-- /media-amendment -->

<!-- media-follow-up bd4d1ecf940f9cf9986182c615d680b2bb22142613536dc85c4875c82b5fb430 -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-storyWorld\-1

<!-- media-amendment c6b5a66c95525347b5eee411461d75a4cd5be07ba168c6f994ae69d4b2192a79 -->
<!-- /media-amendment -->

<!-- media-follow-up e2cee7a47853dd5bd0f4b1160de0f59df4cbadc92dd98c4697939edfc1967439 -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-storyWorld\-2

<!-- media-amendment edbf5a4a15caf5d9017bd236c228e4fe7984c24b8ac0d07b67a78f3b8c881d65 -->
<!-- /media-amendment -->

<!-- media-follow-up 6caae9ca8c163a976640c7cbd533b03af13b0e292096861f27182996810599b5 -->
- **Baldur\'s Gate 3** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Baldur\'s Gate 3 Early Access Review in Progress – First Impressions](<https://sea.ign.com/review/164588/baldurs-gate-3-early-access-review-in-progress-first-impressions>)
  - Source version: 3cdd68cbcab3bf11c6c5f9a5442b56141249ebe28732b2568f68afbb322add65
  - Observation: legacy\-storyWorld\-3

<!-- media-amendment 3687b9b6a8f815663199bd8c8f53ff61c08d172fbd5c8fe336b2004d76601db9 -->
<!-- /media-amendment -->

<!-- media-follow-up bb9deefdee53255873d1531e886cc6af8f80f82cfdc7a19b88e2445a468fed78 -->
- **Cyberpunk 2077** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Cyberpunk 2077 review](<https://www.pcgamer.com/cyberpunk-2077-review/>)
  - Source version: a42909cd601b6007e2c2d10bb8ee3278a4b50c3b362049f36012fa2b693a0a56
  - Observation: legacy\-1

<!-- media-amendment a33164139b50b01e44b467b25707c3fc38399aafd67ecdc0f0b219d076d9968c -->
<!-- /media-amendment -->

<!-- media-follow-up 56c10f723fa98e1274b573617cbe6a70dd5d80ea1b2d03ff88496488ddd4d57c -->
- **Cyberpunk 2077** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Cyberpunk 2077 review](<https://www.pcgamer.com/cyberpunk-2077-review/>)
  - Source version: a42909cd601b6007e2c2d10bb8ee3278a4b50c3b362049f36012fa2b693a0a56
  - Observation: legacy\-3

  - Decision: PC Gamer praises the endings. Completing optional character stories can change the outcome.

<!-- media-amendment 0064af6b3447c9c43fafde4bfc2fb06d5c1d9ebbfa35869125332b4cc0aeb340 -->
Completing optional character stories can change how the main story ends (50GB Day 0 patch, PC).
<!-- /media-amendment -->

<!-- media-follow-up 0774d470919ec28aa5d17908c01fba1b0e5d4efa6461349650ba9269f811cd6c -->
- **Cyberpunk 2077** — What wording and scope does this observation support\? referenced observation has a different evidence category\.
  - Source: [Cyberpunk 2077 review](<https://www.pcgamer.com/cyberpunk-2077-review/>)
  - Source version: a42909cd601b6007e2c2d10bb8ee3278a4b50c3b362049f36012fa2b693a0a56
  - Observation: legacy\-6

<!-- media-amendment a70893a3f59253bd7048a7fb7ef90c4033053aec07d6c21bfbaddfd3b4d885ed -->
<!-- /media-amendment -->
