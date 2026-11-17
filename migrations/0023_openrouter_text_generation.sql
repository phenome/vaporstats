ALTER TABLE `media_processing_jobs` ADD `generation_id` text;--> statement-breakpoint
ALTER TABLE `media_processing_jobs` ADD `routed_provider` text;--> statement-breakpoint
ALTER TABLE `media_processing_jobs` ADD `routed_model` text;--> statement-breakpoint
-- Text generation moves from Gemini Batch to OpenRouter chat completions.
-- Extraction and Overview items that wait in the queue and were never
-- submitted move to OpenRouter with their enqueue time, and so their place,
-- kept; their Gemini backoff no longer applies. Submitted Gemini batches are
-- still polled and settled, and retained rows keep every value as history.
UPDATE `media_processing_jobs`
SET `provider` = 'openrouter', `model` = 'anthropic/claude-haiku-5.5', `attempt_count` = 0, `next_attempt_at` = NULL, `error` = NULL
WHERE `provider` = 'gemini' AND `status` = 'queued' AND `retained` = 0 AND `stage` IN ('extraction', 'synthesis');
