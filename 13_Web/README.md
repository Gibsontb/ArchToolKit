# 13_Web

## Purpose

This folder is the active runtime delivery surface for ArchToolKit.

## Current Status

This is the **working web runtime layer**.

The current application is served from:

- `13_Web/static/`

This structure was preserved intentionally to avoid breaking existing runtime behavior during migration.

## Rules

- Do not restructure this area casually
- Do not replace working runtime files with placeholders
- Validate runtime before making any path or asset changes

## Near-Term Direction

The long-term goal is to make this runtime consume canonical data from `11_DataModels` more intentionally while preserving stability.