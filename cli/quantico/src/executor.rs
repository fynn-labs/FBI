use crate::scenario::{Scenario, Step};
use std::io::Write;

pub struct ExecCtx<'a, W: Write> {
    pub stdout: &'a mut W,
    pub speed_mult: f64, // wall-time = sleep_ms / speed_mult
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub cwd: String,
    pub argv: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Exited(i32),
    SleepingForever,
}

pub fn run<W: Write>(scenario: &Scenario, ctx: &mut ExecCtx<W>) -> std::io::Result<Outcome> {
    for step in &scenario.steps {
        match step {
            Step::Emit(s) | Step::EmitAnsi(s) => {
                ctx.stdout.write_all(s.as_bytes())?;
                ctx.stdout.flush()?;
            }
            Step::SleepMs(ms) => {
                let real_ms = (*ms as f64 / ctx.speed_mult).max(0.0) as u64;
                std::thread::sleep(std::time::Duration::from_millis(real_ms));
            }
            Step::Exit(code) => return Ok(Outcome::Exited(*code)),
            Step::SleepForever => return Ok(Outcome::SleepingForever),
            Step::EchoEnv(vars) => {
                writeln!(ctx.stdout, "[quantico] cwd={}", ctx.cwd)?;
                writeln!(ctx.stdout, "[quantico] argv: {}", ctx.argv.join(" "))?;
                for v in vars {
                    let val = (ctx.env)(v).unwrap_or_default();
                    writeln!(ctx.stdout, "[quantico] env.{}={}", v, val)?;
                }
                ctx.stdout.flush()?;
            }
            // Other steps (jsonl, limit) added in later tasks.
            _ => {
                writeln!(ctx.stdout, "[quantico] step not yet implemented: {:?}", step)?;
            }
        }
    }
    Ok(Outcome::Exited(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Step;

    fn fake_env(_: &str) -> Option<String> { None }

    fn ctx<'a, W: Write>(out: &'a mut W) -> ExecCtx<'a, W> {
        ExecCtx {
            stdout: out,
            speed_mult: 1.0,
            env: &fake_env,
            cwd: "/workspace".into(),
            argv: vec!["--dangerously-skip-permissions".into()],
        }
    }

    #[test]
    fn emits_text_then_exits() {
        let scenario = Scenario {
            name: "t".into(),
            steps: vec![Step::Emit("hi\n".into()), Step::Exit(0)],
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut c = ctx(&mut buf);
        let outcome = run(&scenario, &mut c).unwrap();
        assert_eq!(outcome, Outcome::Exited(0));
        assert_eq!(String::from_utf8(buf).unwrap(), "hi\n");
    }

    #[test]
    fn sleep_ms_scales_with_speed_mult() {
        let scenario = Scenario {
            name: "t".into(),
            steps: vec![Step::SleepMs(200)],
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut c = ctx(&mut buf);
        c.speed_mult = 100.0;
        let start = std::time::Instant::now();
        run(&scenario, &mut c).unwrap();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 100, "expected <100ms sped up, got {}ms", elapsed);
    }

    #[test]
    fn echo_env_emits_block() {
        fn env(name: &str) -> Option<String> {
            if name == "RUN_ID" { Some("42".into()) } else { None }
        }
        let scenario = Scenario {
            name: "t".into(),
            steps: vec![Step::EchoEnv(vec!["RUN_ID".into(), "MISSING".into()]), Step::Exit(0)],
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut c = ExecCtx {
            stdout: &mut buf,
            speed_mult: 1.0,
            env: &env,
            cwd: "/workspace".into(),
            argv: vec![],
        };
        run(&scenario, &mut c).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("[quantico] env.RUN_ID=42"));
        assert!(s.contains("[quantico] env.MISSING="));
    }
}
