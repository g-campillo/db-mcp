//! Go duration parsing, kept so DB_QUERY_TIMEOUT values already written into
//! project .mcp.json files ("30s", "1m30s", "500ms") keep working unchanged.
//!
//! Mirrors Go's time.ParseDuration: an optional sign, then one or more
//! <number><unit> groups, where the number may carry a fraction. A bare "0" is
//! the one value allowed without a unit.

use anyhow::{Result, bail};

/// How many milliseconds one of `unit` is, or `None` for an unknown unit.
fn unit_ms(unit: &str) -> Option<f64> {
    match unit {
        "ns" => Some(1e-6),
        // "\u{b5}" is µ (MICRO SIGN), "\u{3bc}" is μ (GREEK SMALL LETTER MU).
        "us" | "\u{b5}s" | "\u{3bc}s" => Some(1e-3),
        "ms" => Some(1.0),
        "s" => Some(1_000.0),
        "m" => Some(60_000.0),
        "h" => Some(3_600_000.0),
        _ => None,
    }
}

/// Parses a Go duration string and returns it in milliseconds.
pub fn parse_go_duration(input: &str) -> Result<f64> {
    let s = input.trim();
    let b = s.as_bytes();
    if b.is_empty() {
        bail!("invalid duration \"{input}\"");
    }

    let mut i = 0;
    let mut neg = false;
    if b[0] == b'-' || b[0] == b'+' {
        neg = b[0] == b'-';
        i += 1;
    }

    // Special case: a bare zero needs no unit.
    if &s[i..] == "0" {
        return Ok(0.0);
    }
    if i >= b.len() {
        bail!("invalid duration \"{input}\"");
    }

    let mut total = 0.0;
    while i < b.len() {
        // The number: digits, optionally a '.' and more digits.
        let num_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i < b.len() && b[i] == b'.' {
            i += 1;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
        }
        let num_text = &s[num_start..i];
        if num_text.is_empty() || num_text == "." {
            bail!("invalid duration \"{input}\"");
        }

        // The unit: everything up to the next digit or '.'.
        let unit_start = i;
        while i < b.len() && !b[i].is_ascii_digit() && b[i] != b'.' {
            i += 1;
        }
        let unit = &s[unit_start..i];
        if unit.is_empty() {
            bail!("missing unit in duration \"{input}\"");
        }
        let Some(mult) = unit_ms(unit) else {
            bail!("unknown unit \"{unit}\" in duration \"{input}\"");
        };

        let value: f64 = num_text.parse()?;
        total += value * mult;
    }

    Ok(if neg { -total } else { total })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_go_durations() {
        let cases = [
            ("0", 0.0),
            ("30s", 30_000.0),
            ("1m", 60_000.0),
            ("1m30s", 90_000.0),
            ("500ms", 500.0),
            ("2h", 7_200_000.0),
            ("1h15m", 4_500_000.0),
            ("1.5s", 1_500.0),
            ("100us", 0.1),
            ("100\u{b5}s", 0.1),
            ("1000ns", 0.001),
            ("-5s", -5_000.0),
            ("+5s", 5_000.0),
        ];
        for (input, want) in cases {
            let got = parse_go_duration(input)
                .unwrap_or_else(|err| panic!("{input:?} should parse, got error: {err}"));
            assert!(
                (got - want).abs() < 1e-6,
                "{input:?}: got {got}, want {want}"
            );
        }
    }

    #[test]
    fn rejects_malformed_durations() {
        for input in ["", "nope", "30", "s", "1x", "..", "1.s2"] {
            assert!(
                parse_go_duration(input).is_err(),
                "{input:?} should be rejected"
            );
        }
    }
}
