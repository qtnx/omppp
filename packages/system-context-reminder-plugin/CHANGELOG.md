# Changelog

## [Unreleased]

### Fixed

- Kept the System Context Reminder prompt as the final provider system text block for Anthropic-style request payloads.
- Required the System Context Reminder persona check to address the user as Ngài or lord instead of the old bố/con terms.

## [1.0.7] - 2026-06-09

### Added

- Added the System Context Reminder extension for detecting system-context drift and reminding default-loaded omp sessions to follow the full system prompt.
- Added triggering assistant model metadata to hidden System Context Reminder messages for stats attribution.
