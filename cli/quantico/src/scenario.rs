use serde::{Deserialize, Serialize};
use serde::de::{self, Deserializer, MapAccess, Visitor};
use std::fmt;

#[derive(Debug, Serialize, PartialEq)]
pub enum Step {
    Emit(String),
    EmitAnsi(String),
    SleepMs(u64),
    Exit(i32),
    SleepForever,
    EchoEnv(Vec<String>),
    EmitLimitBreach { reset_epoch: String },
    WriteJsonl { kind: String, content: String },
}

// Step does NOT derive Deserialize: serde_yaml 0.9 dropped support for
// externally-tagged enums via the map form (`- emit: "..."`), so we hand-roll
// the visitor below to support both that form and bare-string variants.
impl<'de> Deserialize<'de> for Step {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // A Step is either a plain string ("sleep_forever") or a single-key map.
        struct StepVisitor;

        impl<'de> Visitor<'de> for StepVisitor {
            type Value = Step;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "a step (string or single-key map)")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Step, E> {
                match v {
                    "sleep_forever" => Ok(Step::SleepForever),
                    other => Err(E::unknown_variant(other, VARIANTS)),
                }
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Step, A::Error> {
                let key: String = map.next_key()?.ok_or_else(|| de::Error::custom("empty map"))?;
                let step = match key.as_str() {
                    "emit" => {
                        let v: String = map.next_value()?;
                        Step::Emit(v)
                    }
                    "emit_ansi" => {
                        let v: String = map.next_value()?;
                        Step::EmitAnsi(v)
                    }
                    "sleep_ms" => {
                        let v: u64 = map.next_value()?;
                        Step::SleepMs(v)
                    }
                    "exit" => {
                        let v: i32 = map.next_value()?;
                        Step::Exit(v)
                    }
                    "sleep_forever" => {
                        let _: bool = map.next_value()?;
                        Step::SleepForever
                    }
                    "echo_env" => {
                        let v: Vec<String> = map.next_value()?;
                        Step::EchoEnv(v)
                    }
                    "emit_limit_breach" => {
                        #[derive(Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct LimitBreach { reset_epoch: String }
                        let v: LimitBreach = map.next_value()?;
                        Step::EmitLimitBreach { reset_epoch: v.reset_epoch }
                    }
                    "write_jsonl" => {
                        #[derive(Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct WriteJsonl {
                            #[serde(rename = "type")]
                            kind: String,
                            content: String,
                        }
                        let v: WriteJsonl = map.next_value()?;
                        Step::WriteJsonl { kind: v.kind, content: v.content }
                    }
                    other => {
                        return Err(de::Error::unknown_variant(other, VARIANTS));
                    }
                };
                // Ensure no trailing keys
                if map.next_key::<String>()?.is_some() {
                    return Err(de::Error::custom("step map has more than one key"));
                }
                Ok(step)
            }
        }

        const VARIANTS: &[&str] = &[
            "emit", "emit_ansi", "sleep_ms", "exit", "sleep_forever",
            "echo_env", "emit_limit_breach", "write_jsonl",
        ];

        deserializer.deserialize_any(StepVisitor)
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct Scenario {
    pub name: String,
    pub steps: Vec<Step>,
}

impl Scenario {
    pub fn parse(yaml: &str) -> Result<Self, String> {
        serde_yaml::from_str(yaml).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_scenario() {
        let yaml = r#"
name: simple
steps:
  - emit: "hello\n"
  - sleep_ms: 100
  - exit: 0
"#;
        let s = Scenario::parse(yaml).unwrap();
        assert_eq!(s.name, "simple");
        assert_eq!(s.steps.len(), 3);
        assert_eq!(s.steps[0], Step::Emit("hello\n".into()));
        assert_eq!(s.steps[1], Step::SleepMs(100));
        assert_eq!(s.steps[2], Step::Exit(0));
    }

    #[test]
    fn parses_limit_breach_step() {
        let yaml = r#"
name: lb
steps:
  - emit_limit_breach:
      reset_epoch: "+1h"
"#;
        let s = Scenario::parse(yaml).unwrap();
        assert_eq!(
            s.steps[0],
            Step::EmitLimitBreach { reset_epoch: "+1h".into() }
        );
    }

    #[test]
    fn rejects_unknown_step_type() {
        let yaml = r#"
name: bad
steps:
  - frobnicate: 1
"#;
        assert!(Scenario::parse(yaml).is_err());
    }

    #[test]
    fn parses_sleep_forever_in_both_forms() {
        let yaml_string = r#"
name: a
steps:
  - sleep_forever
"#;
        let s1 = Scenario::parse(yaml_string).unwrap();
        assert_eq!(s1.steps, vec![Step::SleepForever]);

        let yaml_map = r#"
name: b
steps:
  - sleep_forever: true
"#;
        let s2 = Scenario::parse(yaml_map).unwrap();
        assert_eq!(s2.steps, vec![Step::SleepForever]);
    }

    #[test]
    fn parses_emit_ansi() {
        let yaml = r#"
name: a
steps:
  - emit_ansi: "\x1b[32mok\x1b[0m\n"
"#;
        let s = Scenario::parse(yaml).unwrap();
        assert_eq!(s.steps[0], Step::EmitAnsi("\x1b[32mok\x1b[0m\n".into()));
    }

    #[test]
    fn parses_echo_env() {
        let yaml = r#"
name: a
steps:
  - echo_env:
      - RUN_ID
      - HOME
"#;
        let s = Scenario::parse(yaml).unwrap();
        assert_eq!(s.steps[0], Step::EchoEnv(vec!["RUN_ID".into(), "HOME".into()]));
    }

    #[test]
    fn parses_write_jsonl() {
        let yaml = r#"
name: a
steps:
  - write_jsonl:
      type: user
      content: hello
"#;
        let s = Scenario::parse(yaml).unwrap();
        assert_eq!(s.steps[0], Step::WriteJsonl { kind: "user".into(), content: "hello".into() });
    }

    #[test]
    fn rejects_typo_in_write_jsonl() {
        let yaml = r#"
name: a
steps:
  - write_jsonl:
      type: user
      contnet: hello
"#;
        assert!(Scenario::parse(yaml).is_err(), "deny_unknown_fields should reject typo");
    }

    #[test]
    fn rejects_non_bool_sleep_forever_value() {
        let yaml = r#"
name: a
steps:
  - sleep_forever: 42
"#;
        assert!(Scenario::parse(yaml).is_err());
    }
}

const DEFAULT_YAML: &str = include_str!("../scenarios/default.yaml");
const ENV_ECHO_YAML: &str = include_str!("../scenarios/env-echo.yaml");

pub fn lookup(name: &str) -> Option<Scenario> {
    let yaml = match name {
        "default" => DEFAULT_YAML,
        "env-echo" => ENV_ECHO_YAML,
        _ => return None,
    };
    Some(Scenario::parse(yaml).expect("built-in scenario must parse"))
}

pub const BUILT_IN_NAMES: &[&str] = &["default", "env-echo"];

#[cfg(test)]
mod lookup_tests {
    use super::*;

    #[test]
    fn default_is_present_and_parses() {
        let s = lookup("default").expect("default exists");
        assert_eq!(s.name, "default");
        assert!(!s.steps.is_empty());
    }

    #[test]
    fn env_echo_is_present_and_parses() {
        let s = lookup("env-echo").expect("env-echo exists");
        assert_eq!(s.name, "env-echo");
    }

    #[test]
    fn unknown_returns_none() {
        assert!(lookup("nope").is_none());
    }

    #[test]
    fn built_in_names_all_resolve() {
        for n in BUILT_IN_NAMES {
            assert!(lookup(n).is_some(), "built-in {} did not resolve", n);
        }
    }
}
