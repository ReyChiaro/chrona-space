"""Chrona video-generator service.

Owns prompt composition (D-14) and the model adapter boundary (D-19).
No model is loaded in v1: `/generate` returns a degraded result so the rest of
the pipeline can be exercised end to end.
"""
