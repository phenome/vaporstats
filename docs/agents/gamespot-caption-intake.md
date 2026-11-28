# GameSpot caption intake

Caption intake uses operator-approved files. Verify that each upload belongs to the official GameSpot channel (`UCbu2SsF-Or3Rsn3NxqODImw`), covers the selected Steam app, and has usable English captions that VaporStats has permission to process. Check the caption track for intelligible speech and enough speaker context to attribute statements. Supply the actual publisher title, publication date when known, and the developer name for a developer interview. Leave `developer` null for other reporting.

Set `MEDIA_GAMESPOT_CAPTION_DIRECTORY` to the directory holding the approved files. With automatic media ingestion enabled, the next due preview occurrence for a watched, eligible game considers the matching manifest. The preview ceiling still applies. For the longer Warlock interview, use `3714800.json` and, for a track identified as `en`, `aemQLUwnw7I.en.vtt`.

The manifest is a JSON array. Use the following field structure and fill in the verified title and caption language from the capture.

```json
[
  {
    "id": "aemQLUwnw7I",
    "channelId": "UCbu2SsF-Or3Rsn3NxqODImw",
    "title": "Verified GameSpot video title",
    "developer": "Invoke",
    "publishedOn": null,
    "language": "en"
  }
]
```

Store each WebVTT file under `<id>.<language>.vtt`. Supply the actual English track code. Regional English tracks are accepted. The file stays in the configured directory for extraction or bounded provider retries. A missing file keeps an admitted extraction queued until approved captions are available again. The database stores the canonical YouTube URL, publisher, source metadata, content hash, and existing extraction outputs.

VaporStats reads these files locally. Caption acquisition happens separately under YouTube's applicable access and rate limits. GameSpot website access continues to use the normal outlet guard.
