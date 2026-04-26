#[derive(Debug, PartialEq)]
pub enum Invocation {
    Run {
        scenario: Option<String>,
        scenario_file: Option<String>,
        resume_session_id: Option<String>,
    },
    PluginMarketplaceAdd(String),
    PluginInstall(String),
    Unsupported(String),
}

pub fn parse(args: &[String]) -> Invocation {
    // args: argv excluding the program name.
    let mut iter = args.iter().peekable();
    let first = match iter.peek() {
        Some(s) => s.as_str(),
        None => return Invocation::Run {
            scenario: None, scenario_file: None, resume_session_id: None,
        },
    };

    if first == "plugin" {
        iter.next();
        match iter.next().map(String::as_str) {
            Some("marketplace") if iter.next().map(String::as_str) == Some("add") => {
                let name = iter.next().cloned().unwrap_or_default();
                return Invocation::PluginMarketplaceAdd(name);
            }
            Some("install") => {
                let name = iter.next().cloned().unwrap_or_default();
                return Invocation::PluginInstall(name);
            }
            other => return Invocation::Unsupported(format!("plugin {:?}", other)),
        }
    }

    let mut scenario = None;
    let mut scenario_file = None;
    let mut resume_session_id = None;
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--dangerously-skip-permissions" => {}
            "--resume" => {
                resume_session_id = iter.next().cloned();
            }
            "--scenario" => {
                scenario = iter.next().cloned();
            }
            "--scenario-file" => {
                scenario_file = iter.next().cloned();
            }
            other => return Invocation::Unsupported(other.to_string()),
        }
    }
    Invocation::Run { scenario, scenario_file, resume_session_id }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fresh_run() {
        assert_eq!(
            parse(&argv(&["--dangerously-skip-permissions"])),
            Invocation::Run { scenario: None, scenario_file: None, resume_session_id: None }
        );
    }

    #[test]
    fn resume_flag() {
        assert_eq!(
            parse(&argv(&["--resume", "abc-123", "--dangerously-skip-permissions"])),
            Invocation::Run {
                scenario: None,
                scenario_file: None,
                resume_session_id: Some("abc-123".into()),
            }
        );
    }

    #[test]
    fn scenario_flag() {
        assert_eq!(
            parse(&argv(&["--scenario", "limit-breach", "--dangerously-skip-permissions"])),
            Invocation::Run {
                scenario: Some("limit-breach".into()),
                scenario_file: None,
                resume_session_id: None,
            }
        );
    }

    #[test]
    fn plugin_marketplace_add() {
        assert_eq!(
            parse(&argv(&["plugin", "marketplace", "add", "foo/bar"])),
            Invocation::PluginMarketplaceAdd("foo/bar".into())
        );
    }

    #[test]
    fn plugin_install() {
        assert_eq!(
            parse(&argv(&["plugin", "install", "name@source"])),
            Invocation::PluginInstall("name@source".into())
        );
    }

    #[test]
    fn unsupported_flag() {
        match parse(&argv(&["--something-weird"])) {
            Invocation::Unsupported(_) => {}
            other => panic!("expected Unsupported, got {:?}", other),
        }
    }
}
