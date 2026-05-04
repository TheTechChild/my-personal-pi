import asyncio
import json
import sys

import docker

from mcp_server_docker import ServerSettings, run_stdio
from mcp_server_docker.input_schemas import CreateContainerInput, RecreateContainerInput


def _ensure_array_items(node):
    if isinstance(node, dict):
        if node.get("type") == "array" and "items" not in node:
            node["items"] = {}
        for value in node.values():
            _ensure_array_items(value)
        return

    if isinstance(node, list):
        for value in node:
            _ensure_array_items(value)


def _patch_model_json_schema(model_cls):
    original = model_cls.model_json_schema.__func__

    def patched(cls, *args, **kwargs):
        schema = original(cls, *args, **kwargs)
        _ensure_array_items(schema)
        return schema

    model_cls.model_json_schema = classmethod(patched)


def _apply_schema_patch():
    _patch_model_json_schema(CreateContainerInput)
    _patch_model_json_schema(RecreateContainerInput)


def _print_schema():
    schema = CreateContainerInput.model_json_schema()
    print(json.dumps(schema, indent=2))


def main():
    _apply_schema_patch()

    if len(sys.argv) > 1 and sys.argv[1] == "--print-schema":
        _print_schema()
        return

    asyncio.run(run_stdio(ServerSettings(), docker.from_env()))


if __name__ == "__main__":
    main()
