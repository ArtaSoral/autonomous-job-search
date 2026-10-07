# Autonomous Job Search

A new project to build a fully autonomous tool that finds jobs matching Uri's experience and creates customized resumes and cover letters for suitable roles.

## Intended workflow

1. Search the web and employer career pages for current job openings.
2. Collect full job descriptions, source URLs, requirements, and available compensation and location information.
3. Match each role against the candidate's documented experience and preferences, explaining fit and gaps.
4. Select relevant, supported experience and generate a customized resume and cover letter.
5. Maintain a local record of discovered jobs, match decisions, and generated documents, avoiding duplicate work.

Detailed requirements, architecture, and implementation will be developed in this repository. See [the project scope](docs/project-scope.md).

## Candidate data

A copy of the existing resume bank is available locally at `candidate/resume_bank.json`. It is ignored by Git because it contains personal information. Generated documents, job databases, and credentials are also ignored.

## Current state

This repository contains the initial project brief and local candidate data. No search engine, document generator, or autonomous runner has been implemented yet.
