# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- Initial protocol draft: AEP as a domain profile of MEP Core 1, with the audio domain
  model, operation set, and action table.
- Reference SDK (`@aep/schema`, `@aep/core`, `@aep/host`, `@aep/client`, `@aep/transport`,
  `@aep/testing`) implementing the protocol over the local binding.
- Conformance suite (`pnpm run conformance`) and published JSON Schemas under `schemas/`.
