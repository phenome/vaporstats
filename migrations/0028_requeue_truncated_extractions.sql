-- Repairs the extractions that Claude Haiku 5.5's default reasoning cut off on
-- the first live run (2026-11-18; ADR 0018, amended 2026-11-18). Reasoning
-- counted against the 1,200-token output cap, so an answer could end at the
-- cap before its JSON was complete, and the item was refused as invalid output.
-- An OpenRouter extraction refused as invalid output whose recorded completion
-- tokens equal its cap was cut off this way. It returns to the Paid-work queue,
-- ready now, under the corrected 3,200-token cap, so it is extracted once more
-- without a correction set. Its attempts, usage, generation and cost stay as
-- recorded. A refusal whose answer ended below its cap was complete and stays
-- refused. No other row changes, and no row is deleted or remapped.
UPDATE `media_processing_jobs`
SET `status` = 'queued',
	`max_output_tokens` = 3200,
	`error` = NULL,
	`next_attempt_at` = NULL,
	`completed_at` = NULL
WHERE `stage` = 'extraction'
	AND `provider` = 'openrouter'
	AND `retained` = 0
	AND `status` = 'refused'
	AND `error` LIKE 'invalid_output:%'
	AND json_valid(`usage_json`)
	AND json_extract(`usage_json`, '$.completionTokens') = `max_output_tokens`;
