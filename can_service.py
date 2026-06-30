#!/usr/bin/env python3
"""Executable entry point for the Sprinter CAN collector service."""

from sprinter_can.service import run


if __name__ == "__main__":
    raise SystemExit(run())
