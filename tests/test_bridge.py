"""Tests for gyoshu_bridge.py - JSON-RPC Python execution bridge."""

import sys
import os
import json
import io
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "bridge"))

from gyoshu_bridge import (
    parse_markers,
    get_memory_usage,
    clean_memory,
    execute_code,
    ExecutionState,
    make_error,
    send_response,
    process_request,
    handle_execute,
    handle_reset,
    handle_get_state,
    handle_ping,
    ERROR_PARSE,
    ERROR_INVALID_REQUEST,
    ERROR_METHOD_NOT_FOUND,
    ERROR_INVALID_PARAMS,
    MARKER_CATEGORIES,
    JSON_RPC_VERSION,
)

import pytest


class TestParseMarkers:
    """Tests for parse_markers() function - marker extraction from output text."""

    def test_simple_marker(self):
        text = "[STEP] Loading data..."
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "STEP"
        assert markers[0]["subtype"] is None
        assert markers[0]["content"] == "Loading data..."
        assert markers[0]["category"] == "workflow"

    def test_marker_with_subtype(self):
        text = "[METRIC:accuracy] 0.95"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "METRIC"
        assert markers[0]["subtype"] == "accuracy"
        assert markers[0]["content"] == "0.95"
        assert markers[0]["category"] == "calculations"

    def test_multiple_markers(self):
        text = """[OBJECTIVE] Test data analysis
[HYPOTHESIS] Data will show pattern
[FINDING] Pattern confirmed"""
        markers = parse_markers(text)

        assert len(markers) == 3
        assert markers[0]["type"] == "OBJECTIVE"
        assert markers[1]["type"] == "HYPOTHESIS"
        assert markers[2]["type"] == "FINDING"

    def test_no_markers(self):
        text = "Regular output without any markers"
        markers = parse_markers(text)
        assert len(markers) == 0

    def test_empty_text(self):
        markers = parse_markers("")
        assert len(markers) == 0

    def test_marker_line_numbers(self):
        text = """Line 1 no marker
[STEP] Line 2 marker
Line 3 no marker
[INFO] Line 4 marker"""
        markers = parse_markers(text)

        assert len(markers) == 2
        assert markers[0]["line_number"] == 2
        assert markers[1]["line_number"] == 4

    def test_marker_with_leading_whitespace(self):
        text = "  [STEP] Indented marker"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "STEP"

    def test_all_marker_categories(self):
        for marker_type, expected_category in MARKER_CATEGORIES.items():
            text = f"[{marker_type}] test content"
            markers = parse_markers(text)

            assert len(markers) == 1, f"Failed for {marker_type}"
            assert markers[0]["category"] == expected_category, (
                f"Failed for {marker_type}"
            )

    def test_unknown_marker_category(self):
        text = "[UNKNOWN_MARKER] some content"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "UNKNOWN_MARKER"
        assert markers[0]["category"] == "unknown"

    def test_marker_complex_subtype(self):
        text = "[PLOT:scatter_matrix_2d] Distribution plot"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["subtype"] == "scatter_matrix_2d"

    def test_marker_with_hyphen_normalized_to_underscore(self):
        text = "[CHALLENGE-RESPONSE:1] Re-verified correlation"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "CHALLENGE_RESPONSE"
        assert markers[0]["subtype"] == "1"
        assert markers[0]["content"] == "Re-verified correlation"
        assert markers[0]["category"] == "scientific"

    def test_marker_with_hyphen_and_underscore_equivalent(self):
        text1 = "[CHALLENGE-RESPONSE:2] Response A"
        text2 = "[CHALLENGE_RESPONSE:2] Response B"

        markers1 = parse_markers(text1)
        markers2 = parse_markers(text2)

        assert markers1[0]["type"] == markers2[0]["type"] == "CHALLENGE_RESPONSE"
        assert markers1[0]["category"] == markers2[0]["category"] == "scientific"

    def test_marker_independent_check_with_hyphen(self):
        text = "[INDEPENDENT-CHECK] Bootstrap confirms result"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "INDEPENDENT_CHECK"
        assert markers[0]["category"] == "scientific"

    def test_subtype_hyphen_normalized_to_underscore(self):
        text = "[STAT:effect-size] Cohen's d = 0.75"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "STAT"
        assert markers[0]["subtype"] == "effect_size"
        assert markers[0]["content"] == "Cohen's d = 0.75"

    def test_subtype_with_multiple_hyphens_normalized(self):
        text = "[METRIC:cross-val-accuracy] 0.95"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["subtype"] == "cross_val_accuracy"

    def test_marker_with_attributes_key_value(self):
        text = "[STAGE:begin:id=S01:stage=load_data] Loading..."
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "STAGE"
        assert markers[0]["subtype"] == "begin"
        assert markers[0]["attributes"] == {"id": "S01", "stage": "load_data"}
        assert markers[0]["content"] == "Loading..."
        assert markers[0]["valid"] is True

    def test_marker_with_only_key_value_no_subtype(self):
        text = "[CHECKPOINT:id=ckpt-001:stage=S02] Saved"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "CHECKPOINT"
        assert markers[0]["subtype"] is None
        assert markers[0]["attributes"] == {"id": "ckpt-001", "stage": "S02"}
        assert markers[0]["content"] == "Saved"

    def test_marker_with_subtype_and_single_attribute(self):
        text = "[CHECKPOINT:saved:id=ckpt-002] Checkpoint saved"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "CHECKPOINT"
        assert markers[0]["subtype"] == "saved"
        assert markers[0]["attributes"] == {"id": "ckpt-002"}

    def test_marker_attributes_empty_dict_when_simple_subtype(self):
        text = "[METRIC:accuracy] 0.95"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["attributes"] == {}

    def test_marker_no_attributes_no_subtype(self):
        text = "[FINDING] Key discovery here"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["subtype"] is None
        assert markers[0]["attributes"] == {}

    def test_marker_valid_field_true_for_known_type(self):
        text = "[OBJECTIVE] Research goal"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["valid"] is True

    def test_marker_valid_field_false_for_unknown_type(self):
        text = "[CUSTOM_UNKNOWN] Some content"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["valid"] is False
        assert markers[0]["category"] == "unknown"

    def test_marker_multiple_subtypes_become_attributes(self):
        text = "[STAGE:begin:extra:more] Content"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["subtype"] == "begin"
        assert markers[0]["attributes"] == {"extra": "", "more": ""}

    def test_marker_rehydrated_with_from_attribute(self):
        text = "[REHYDRATED:from=ckpt-001] Session restored"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "REHYDRATED"
        assert markers[0]["subtype"] is None
        assert markers[0]["attributes"] == {"from": "ckpt-001"}
        assert markers[0]["valid"] is True

    def test_citation_with_doi_containing_colons(self):
        text = "[CITATION:10.1145/2939672.2939785] XGBoost paper"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "CITATION"
        assert markers[0]["subtype"] == "10.1145/2939672.2939785"
        assert markers[0]["attributes"] == {}
        assert markers[0]["valid"] is True

    def test_citation_with_arxiv_prefix_containing_colon(self):
        text = "[CITATION:arXiv:2301.12345] Transformer paper"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "CITATION"
        assert markers[0]["subtype"] == "arXiv:2301.12345"
        assert markers[0]["attributes"] == {}
        assert markers[0]["valid"] is True

    def test_citation_with_doi_prefix_containing_multiple_colons(self):
        text = "[CITATION:doi:10.1145/2939672.2939785] Another paper"
        markers = parse_markers(text)

        assert len(markers) == 1
        assert markers[0]["type"] == "CITATION"
        assert markers[0]["subtype"] == "doi:10.1145/2939672.2939785"
        assert markers[0]["attributes"] == {}
        assert markers[0]["valid"] is True


class TestMemoryUtils:
    """Tests for memory utility functions."""

    def test_get_memory_usage_returns_dict(self):
        mem = get_memory_usage()

        assert isinstance(mem, dict)
        assert "rss_mb" in mem
        assert "vms_mb" in mem

    def test_get_memory_usage_values_are_floats(self):
        mem = get_memory_usage()

        assert isinstance(mem["rss_mb"], float)
        assert isinstance(mem["vms_mb"], float)

    def test_get_memory_usage_positive_values(self):
        mem = get_memory_usage()

        assert mem["rss_mb"] >= 0
        assert mem["vms_mb"] >= 0

    def test_clean_memory_runs_gc(self):
        mem_before = get_memory_usage()
        mem_after = clean_memory()

        assert isinstance(mem_after, dict)
        assert "rss_mb" in mem_after


class TestExecuteCode:
    """Tests for execute_code() function - Python code execution."""

    def test_successful_execution(self):
        namespace = {}
        result = execute_code("x = 1 + 1", namespace)

        assert result["success"] is True
        assert result["exception"] is None
        assert "x" in namespace
        assert namespace["x"] == 2

    def test_stdout_capture(self):
        namespace = {}
        result = execute_code("print('hello world')", namespace)

        assert result["success"] is True
        assert "hello world" in result["stdout"]

    def test_stderr_capture(self):
        namespace = {}
        code = "import sys; print('error msg', file=sys.stderr)"
        result = execute_code(code, namespace)

        assert result["success"] is True
        assert "error msg" in result["stderr"]

    def test_syntax_error(self):
        namespace = {}
        result = execute_code("def bad syntax", namespace)

        assert result["success"] is False
        assert result["exception_type"] == "SyntaxError"
        assert result["traceback"] is not None

    def test_runtime_error(self):
        namespace = {}
        result = execute_code("undefined_variable", namespace)

        assert result["success"] is False
        assert result["exception_type"] == "NameError"
        assert "undefined_variable" in result["exception"]

    def test_type_error(self):
        namespace = {}
        result = execute_code("'string' + 5", namespace)

        assert result["success"] is False
        assert result["exception_type"] == "TypeError"

    def test_namespace_persistence(self):
        namespace = {}

        execute_code("x = 10", namespace)
        result = execute_code("y = x * 2", namespace)

        assert result["success"] is True
        assert namespace["y"] == 20

    def test_multiline_code(self):
        namespace = {}
        code = """
def greet(name):
    return f"Hello, {name}!"

result = greet("World")
print(result)
"""
        result = execute_code(code, namespace)

        assert result["success"] is True
        assert "Hello, World!" in result["stdout"]
        assert namespace["result"] == "Hello, World!"

    def test_import_in_execution(self):
        namespace = {}
        code = """
import math
pi_value = math.pi
"""
        result = execute_code(code, namespace)

        assert result["success"] is True
        assert "math" in namespace
        assert abs(namespace["pi_value"] - 3.14159) < 0.001

    def test_empty_code(self):
        namespace = {}
        result = execute_code("", namespace)

        assert result["success"] is True
        assert result["stdout"] == ""

    def test_only_whitespace_code(self):
        namespace = {}
        result = execute_code("   \n\n   ", namespace)

        assert result["success"] is True


class TestExecutionState:
    """Tests for ExecutionState class - namespace and state management."""

    def test_initial_namespace_has_helpers(self):
        state = ExecutionState()

        assert "clean_memory" in state.namespace
        assert "get_memory" in state.namespace
        assert state.namespace["__name__"] == "__gyoshu__"

    def test_reset_clears_user_variables(self):
        state = ExecutionState()
        state.namespace["user_var"] = "test_value"

        result = state.reset()

        assert "user_var" not in state.namespace
        assert result["status"] == "reset"
        assert "memory" in result

    def test_reset_keeps_helper_functions(self):
        state = ExecutionState()
        state.namespace["user_var"] = "test"

        state.reset()

        assert "clean_memory" in state.namespace
        assert "get_memory" in state.namespace

    def test_get_state_returns_user_variables(self):
        state = ExecutionState()
        state.namespace["my_data"] = [1, 2, 3]
        state.namespace["my_func"] = lambda x: x

        result = state.get_state()

        assert "my_data" in result["variables"]
        assert "my_func" in result["variables"]
        assert "clean_memory" not in result["variables"]
        assert "memory" in result
        assert result["variable_count"] == 2

    def test_get_state_excludes_dunder_variables(self):
        state = ExecutionState()

        result = state.get_state()

        assert "__name__" not in result["variables"]
        assert "__doc__" not in result["variables"]

    def test_interrupt_sets_flag(self):
        state = ExecutionState()

        assert not state.interrupt_flag.is_set()

        result = state.interrupt()

        assert state.interrupt_flag.is_set()
        assert result["status"] == "interrupt_requested"

    def test_reset_clears_interrupt_flag(self):
        state = ExecutionState()
        state.interrupt()

        assert state.interrupt_flag.is_set()

        state.reset()

        assert not state.interrupt_flag.is_set()


class TestJSONRPCProtocol:
    """Tests for JSON-RPC 2.0 protocol handling."""

    def test_make_error_basic(self):
        error = make_error(-32600, "Invalid request")

        assert error["code"] == -32600
        assert error["message"] == "Invalid request"
        assert "data" not in error

    def test_make_error_with_data(self):
        error = make_error(-32600, "Invalid request", data={"extra": "info"})

        assert error["code"] == -32600
        assert error["data"]["extra"] == "info"


class TestProcessRequest:
    """Tests for process_request() - JSON-RPC request processing."""

    @pytest.fixture
    def capture_protocol_output(self, monkeypatch):
        captured = io.StringIO()

        def mock_send_protocol(data):
            captured.write(json.dumps(data) + "\n")

        import gyoshu_bridge

        monkeypatch.setattr(gyoshu_bridge, "_send_protocol", mock_send_protocol)

        return captured

    def test_invalid_json_returns_parse_error(self, capture_protocol_output):
        process_request("not valid json{")

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert "error" in response
        assert response["error"]["code"] == ERROR_PARSE

    def test_non_object_request_returns_error(self, capture_protocol_output):
        process_request('"just a string"')

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_INVALID_REQUEST

    def test_missing_jsonrpc_version_returns_error(self, capture_protocol_output):
        request = json.dumps({"id": "1", "method": "ping"})
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_INVALID_REQUEST
        assert "jsonrpc version" in response["error"]["message"].lower()

    def test_wrong_jsonrpc_version_returns_error(self, capture_protocol_output):
        request = json.dumps({"jsonrpc": "1.0", "id": "1", "method": "ping"})
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_INVALID_REQUEST

    def test_missing_method_returns_error(self, capture_protocol_output):
        request = json.dumps({"jsonrpc": "2.0", "id": "1"})
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_INVALID_REQUEST
        assert "method" in response["error"]["message"].lower()

    def test_unknown_method_returns_error(self, capture_protocol_output):
        request = json.dumps(
            {"jsonrpc": "2.0", "id": "1", "method": "nonexistent_method"}
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_METHOD_NOT_FOUND

    def test_invalid_params_type_returns_error(self, capture_protocol_output):
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "1",
                "method": "ping",
                "params": "should be object",
            }
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_INVALID_PARAMS

    def test_ping_method_returns_success(self, capture_protocol_output):
        request = json.dumps({"jsonrpc": "2.0", "id": "ping_001", "method": "ping"})
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["jsonrpc"] == "2.0"
        assert response["id"] == "ping_001"
        assert response["result"]["status"] == "ok"
        assert "timestamp" in response["result"]

    def test_execute_without_code_returns_error(self, capture_protocol_output):
        request = json.dumps(
            {"jsonrpc": "2.0", "id": "1", "method": "execute", "params": {}}
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_INVALID_PARAMS
        assert "code" in response["error"]["message"].lower()

    def test_execute_with_non_string_code_returns_error(self, capture_protocol_output):
        request = json.dumps(
            {"jsonrpc": "2.0", "id": "1", "method": "execute", "params": {"code": 123}}
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["error"]["code"] == ERROR_INVALID_PARAMS

    def test_execute_success(self, capture_protocol_output):
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "exec_001",
                "method": "execute",
                "params": {"code": "print('[STEP] Test marker')"},
            }
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["id"] == "exec_001"
        assert response["result"]["success"] is True
        assert "[STEP] Test marker" in response["result"]["stdout"]
        assert len(response["result"]["markers"]) == 1
        assert "timing" in response["result"]
        assert "memory" in response["result"]

    def test_reset_method(self, capture_protocol_output):
        request = json.dumps({"jsonrpc": "2.0", "id": "reset_001", "method": "reset"})
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["result"]["status"] == "reset"
        assert "memory" in response["result"]

    def test_get_state_method(self, capture_protocol_output):
        request = json.dumps(
            {"jsonrpc": "2.0", "id": "state_001", "method": "get_state"}
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert "variables" in response["result"]
        assert "variable_count" in response["result"]
        assert "memory" in response["result"]


class TestOversizedLineHandling:
    """Tests for FIX-175/FIX-179: oversized line handling without corruption."""

    def test_read_bounded_line_normal(self):
        """Normal line within limit should return (bytes, False)."""
        from gyoshu_bridge import read_bounded_line

        data = b'{"jsonrpc": "2.0", "id": "1", "method": "ping"}\n'
        stream = io.BytesIO(data)
        result, was_oversized = read_bounded_line(stream, 1024)

        assert was_oversized is False
        assert result == data.rstrip(b"\n")

    def test_read_bounded_line_oversized(self):
        """Oversized line should return truncated bytes with oversized=True."""
        from gyoshu_bridge import read_bounded_line

        data = b"x" * 200 + b"\n"
        stream = io.BytesIO(data)
        result, was_oversized = read_bounded_line(stream, 100)

        assert was_oversized is True
        assert len(result) == 100

    def test_read_bounded_line_eof(self):
        """EOF with no data should return (None, False)."""
        from gyoshu_bridge import read_bounded_line

        stream = io.BytesIO(b"")
        result, was_oversized = read_bounded_line(stream, 1024)

        assert result is None
        assert was_oversized is False

    def test_oversized_line_does_not_corrupt_next_request(self):
        """After oversized line, next valid request should work correctly."""
        from gyoshu_bridge import read_bounded_line

        oversized = b"x" * 200 + b"\n"
        valid_line = b'{"valid": "request"}\n'
        stream = io.BytesIO(oversized + valid_line)

        result1, was_oversized1 = read_bounded_line(stream, 100)
        assert was_oversized1 is True

        result2, was_oversized2 = read_bounded_line(stream, 100)
        assert was_oversized2 is False
        assert result2 == b'{"valid": "request"}'

    def test_error_response_includes_id_null_for_preparse(self, monkeypatch):
        """Error responses for pre-parse failures should include id: null."""
        captured = io.StringIO()

        def mock_send_protocol(data):
            captured.write(json.dumps(data) + "\n")

        import gyoshu_bridge

        monkeypatch.setattr(gyoshu_bridge, "_send_protocol", mock_send_protocol)

        process_request("not valid json{")

        output = captured.getvalue()
        response = json.loads(output.strip())

        assert "id" in response
        assert response["id"] is None
        assert "error" in response

    def test_json_decode_error_returns_null_id(self, monkeypatch):
        """JSON decode error should return response with id: null."""
        captured = io.StringIO()

        def mock_send_protocol(data):
            captured.write(json.dumps(data) + "\n")

        import gyoshu_bridge

        monkeypatch.setattr(gyoshu_bridge, "_send_protocol", mock_send_protocol)

        process_request("{invalid json")

        output = captured.getvalue()
        response = json.loads(output.strip())

        assert response["id"] is None
        assert response["error"]["code"] == ERROR_PARSE


class TestExecuteIntegration:
    """Integration tests for execute workflow with markers."""

    @pytest.fixture
    def capture_protocol_output(self, monkeypatch):
        captured = io.StringIO()

        def mock_send_protocol(data):
            captured.write(json.dumps(data) + "\n")

        import gyoshu_bridge

        monkeypatch.setattr(gyoshu_bridge, "_send_protocol", mock_send_protocol)

        return captured

    def test_execute_with_scientific_markers(self, capture_protocol_output):
        code = """
print("[OBJECTIVE] Analyze test data")
print("[HYPOTHESIS] Data will show linear trend")
result = sum(range(10))
print(f"[METRIC:sum] {result}")
print("[CONCLUSION] Analysis complete")
"""
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "sci_001",
                "method": "execute",
                "params": {"code": code},
            }
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["result"]["success"] is True
        markers = response["result"]["markers"]

        marker_types = [m["type"] for m in markers]
        assert "OBJECTIVE" in marker_types
        assert "HYPOTHESIS" in marker_types
        assert "METRIC" in marker_types
        assert "CONCLUSION" in marker_types

        metric_marker = next(m for m in markers if m["type"] == "METRIC")
        assert metric_marker["subtype"] == "sum"

    def test_execute_error_includes_traceback(self, capture_protocol_output):
        code = """
def outer():
    def inner():
        raise ValueError("Test error")
    inner()
outer()
"""
        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "err_001",
                "method": "execute",
                "params": {"code": code},
            }
        )
        process_request(request)

        output = capture_protocol_output.getvalue()
        response = json.loads(output.strip())

        assert response["result"]["success"] is False
        assert "error" in response["result"]
        assert response["result"]["error"]["type"] == "ValueError"
        assert "Test error" in response["result"]["error"]["message"]
        assert "traceback" in response["result"]["error"]

    def test_namespace_persists_across_executions(self, capture_protocol_output):
        import gyoshu_bridge

        gyoshu_bridge._state.reset()

        request1 = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "1",
                "method": "execute",
                "params": {"code": "shared_data = [1, 2, 3]"},
            }
        )
        process_request(request1)

        request2 = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "2",
                "method": "execute",
                "params": {"code": "print(f'Data: {shared_data}')"},
            }
        )
        process_request(request2)

        lines = capture_protocol_output.getvalue().strip().split("\n")
        response2 = json.loads(lines[-1])

        assert response2["result"]["success"] is True
        assert "Data: [1, 2, 3]" in response2["result"]["stdout"]
