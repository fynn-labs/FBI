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
                    "echo_env" => {
                        let v: Vec<String> = map.next_value()?;
                        Step::EchoEnv(v)
                    }
                    "emit_limit_breach" => {
                        #[derive(Deserialize)]
                        struct LimitBreach { reset_epoch: String }
                        let v: LimitBreach = map.next_value()?;
                        Step::EmitLimitBreach { reset_epoch: v.reset_epoch }
                    }
                    "write_jsonl" => {
                        #[derive(Deserialize)]
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
}
