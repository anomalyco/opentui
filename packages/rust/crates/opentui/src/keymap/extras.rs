//! Configuration to bindings, and bindings to text, ported from `@opentui/keymap/extras`.

use super::{Binding, BindingCommand, Key, KeySequencePart};
use std::collections::HashMap;

/// One configured binding for a command: a key, or a binding whose other fields apply too.
#[derive(Clone, Debug)]
pub enum BindingItem<T> {
    Key(Key),
    Binding(Binding<T>),
}

impl<T> From<&str> for BindingItem<T> {
    fn from(key: &str) -> Self {
        Self::Key(key.into())
    }
}

/// A command's configured bindings. `false`, `"none"`, and an empty list all disable the command's keys.
#[derive(Clone, Debug)]
pub enum BindingValue<T> {
    Disabled,
    Items(Vec<BindingItem<T>>),
}

impl<T> BindingValue<T> {
    /// A single key, or `Disabled` for `"none"`.
    pub fn key(key: &str) -> Self {
        if key == "none" { Self::Disabled } else { Self::Items(vec![BindingItem::from(key)]) }
    }
}

/// Fills in a binding's defaults, such as a description for the command, before the binding's own fields.
pub type BindingDefaults<T> = dyn Fn(&str, &mut Binding<T>);

/// Bindings for configured commands, as `createBindingLookup` makes them: each item becomes a binding whose
/// command is the configured name, or that name mapped through a command map.
pub struct BindingLookup<T> {
    by_command: Vec<(String, Vec<Binding<T>>)>,
    gathered: HashMap<String, Vec<String>>,
}

impl<T: Clone> BindingLookup<T> {
    pub fn new(config: impl IntoIterator<Item = (String, BindingValue<T>)>) -> Result<Self, String> {
        Self::with_options(config, None, None)
    }

    /// Builds the lookup with an optional map from configured names to command names and optional defaults.
    pub fn with_options(
        config: impl IntoIterator<Item = (String, BindingValue<T>)>,
        command_map: Option<&HashMap<String, String>>,
        defaults: Option<&BindingDefaults<T>>,
    ) -> Result<Self, String> {
        let mut by_command: Vec<(String, Vec<Binding<T>>)> = Vec::new();
        for (name, value) in config {
            if name.is_empty() {
                return Err("Invalid binding command: command cannot be empty".to_owned());
            }
            let command = match command_map.and_then(|map| map.get(&name)) {
                Some(mapped) if mapped.is_empty() => {
                    return Err(format!("Invalid binding command map entry for \"{name}\": command cannot be empty"));
                }
                Some(mapped) => mapped.clone(),
                None => name,
            };
            let bindings: Vec<Binding<T>> = match value {
                BindingValue::Disabled => Vec::new(),
                BindingValue::Items(items) => items
                    .into_iter()
                    .map(|item| {
                        let mut binding = match item {
                            BindingItem::Key(key) => Binding::new(key),
                            BindingItem::Binding(binding) => binding,
                        };
                        binding.cmd = Some(BindingCommand::Name(command.clone()));
                        if let Some(defaults) = defaults {
                            defaults(&command, &mut binding);
                        }
                        binding
                    })
                    .collect(),
            };
            let existing = by_command.iter().position(|(current, _)| *current == command);
            match (existing, bindings.is_empty()) {
                (Some(index), true) => {
                    by_command.remove(index);
                }
                (Some(index), false) => by_command[index].1 = bindings,
                (None, true) => {}
                (None, false) => by_command.push((command, bindings)),
            }
        }
        Ok(Self { by_command, gathered: HashMap::new() })
    }

    /// Every binding, by command in configuration order.
    pub fn bindings(&self) -> Vec<Binding<T>> {
        self.by_command.iter().flat_map(|(_, bindings)| bindings.iter().cloned()).collect()
    }

    /// The bindings for `command`, empty when it has none.
    pub fn get(&self, command: &str) -> &[Binding<T>] {
        self.by_command.iter().find(|(current, _)| current == command).map_or(&[], |(_, bindings)| bindings)
    }

    pub fn has(&self, command: &str) -> bool {
        self.by_command.iter().any(|(current, _)| current == command)
    }

    /// The bindings of `commands`, in that order, remembered as the group `name`. A group keeps its first commands.
    pub fn gather(&mut self, name: &str, commands: &[&str]) -> Vec<Binding<T>> {
        let members = self
            .gathered
            .entry(name.to_owned())
            .or_insert_with(|| commands.iter().map(|command| (*command).to_owned()).collect())
            .clone();
        members.iter().flat_map(|command| self.get(command).iter().cloned()).collect()
    }

    /// The bindings of `commands` within the group `name`.
    pub fn pick(&self, name: &str, commands: &[&str]) -> Vec<Binding<T>> {
        let Some(members) = self.gathered.get(name) else { return Vec::new() };
        commands
            .iter()
            .filter(|command| members.iter().any(|member| member == *command))
            .flat_map(|command| self.get(command).iter().cloned())
            .collect()
    }

    /// The bindings of the group `name` without those of `commands`.
    pub fn omit(&self, name: &str, commands: &[&str]) -> Vec<Binding<T>> {
        let Some(members) = self.gathered.get(name) else { return Vec::new() };
        members
            .iter()
            .filter(|member| !commands.contains(&member.as_str()))
            .flat_map(|member| self.get(member).iter().cloned())
            .collect()
    }
}

/// How [`format_key_sequence`] and [`format_command_bindings`] write keys.
#[derive(Clone, Debug, Default)]
pub struct FormatOptions {
    /// How to show a token, such as `leader` as `ctrl+x`.
    pub token_display: HashMap<String, String>,
    /// Replacements for key names, such as `up` as `↑`.
    pub key_name_aliases: HashMap<String, String>,
    /// Replacements for `ctrl`, `shift`, `meta`, `super`, and `hyper`, such as `meta` as `alt`.
    pub modifier_aliases: HashMap<String, String>,
    /// Between strokes; a space by default.
    pub separator: Option<String>,
    /// Between bindings; `", "` by default.
    pub binding_separator: Option<String>,
    /// Keeps repeated bindings; they are dropped by default.
    pub keep_duplicates: bool,
}

fn format_stroke(part: &KeySequencePart, options: &FormatOptions) -> String {
    if let Some(token) = &part.token {
        return options.token_display.get(token).cloned().unwrap_or_else(|| part.display.clone());
    }
    if options.key_name_aliases.is_empty() && options.modifier_aliases.is_empty() {
        return part.display.clone();
    }
    let stroke = &part.stroke;
    let mut pieces: Vec<String> = [
        (stroke.ctrl, "ctrl"),
        (stroke.shift, "shift"),
        (stroke.meta, "meta"),
        (stroke.super_, "super"),
        (stroke.hyper, "hyper"),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .map(|(_, modifier)| options.modifier_aliases.get(modifier).cloned().unwrap_or_else(|| modifier.to_owned()))
    .collect();
    let name = if stroke.name == "return" { "enter" } else { &stroke.name };
    pieces.push(options.key_name_aliases.get(name).cloned().unwrap_or_else(|| name.to_owned()));
    pieces.join("+")
}

/// Writes a sequence such as `<leader>` `n` as `ctrl+x n`.
pub fn format_key_sequence(parts: &[KeySequencePart], options: &FormatOptions) -> String {
    let separator = options.separator.as_deref().unwrap_or(" ");
    parts.iter().map(|part| format_stroke(part, options)).collect::<Vec<_>>().join(separator)
}

/// Writes several bindings' sequences, such as `ctrl+c, ctrl+d`. Returns `None` without bindings.
pub fn format_command_bindings<'a>(
    sequences: impl IntoIterator<Item = &'a [KeySequencePart]>,
    options: &FormatOptions,
) -> Option<String> {
    let mut sequences = sequences.into_iter().peekable();
    sequences.peek()?;
    let mut items: Vec<String> = Vec::new();
    for sequence in sequences {
        let item = format_key_sequence(sequence, options);
        if item.is_empty() || (!options.keep_duplicates && items.contains(&item)) {
            continue;
        }
        items.push(item);
    }
    Some(items.join(options.binding_separator.as_deref().unwrap_or(", ")))
}
