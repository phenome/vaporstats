# GameSpot caption intake

Caption intake uses operator-approved files. Verify that each upload belongs to the official GameSpot channel (`UCbu2SsF-Or3Rsn3NxqODImw`), covers the selected Steam app, and has usable English captions that VaporStats has permission to process. Check the caption track for intelligible speech and enough speaker context to attribute statements. Supply the actual publisher title, publication date when known, and the developer name for a developer interview. Leave `developer` null for other reporting.

For an affiliated interview, verify the speaker turns in the approved captions. A developer turn can use a WebVTT voice label or a bracketed speaker label at the start of a line. Use the manifest's developer name, `Developer`, or the speaker's name followed by `(Developer)`. A host's introduction of a guest does not identify the speaker of subsequent unlabeled captions.

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

Store each WebVTT file under `<id>.<language>.vtt`. Supply the actual English track code. Regional English tracks are accepted. Keep the file in the configured directory for extraction and any bounded provider retries. The database stores the canonical YouTube URL, publisher, source metadata, content hash, and existing extraction outputs.

If an admitted extraction cannot read approved captions, the ingestion log reports `approved_captions_unavailable` in `mediaProcessing.stopReasons`. The extraction stays queued with that reason on its job. The Overview can publish using available extractions while the video waits.

To recover, restore `MEDIA_GAMESPOT_CAPTION_DIRECTORY` in the worker configuration if it is unset. Verify that the directory contains a readable `<appid>.json` approving the same video and developer, plus a readable English `<id>.<language>.vtt` matching the manifest. The next eligible ingestion tick checks the bundle and resumes the queued extraction under its existing retry limits. A prior extraction of identical normalized captions is reused without a paid request.

VaporStats reads these files locally. Caption acquisition happens separately under YouTube's applicable access and rate limits. GameSpot website access continues to use the normal outlet guard.
