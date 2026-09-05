# VaporStats

VaporStats presents collected game-market and player-activity data through its website.

## Language

**Internal website API**:
An HTTP endpoint used by VaporStats pages to load site data. It is not a supported interface for third-party integrations or bulk extraction.
_Avoid_: Public API, developer API

## Glossary

**Observation**: One timestamped player/price measurement before aggregation.

**Rollup**: A durable aggregate derived from observations for a defined UTC period.
