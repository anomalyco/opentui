use crate::style::Span;

/// Text with optional styling: a plain string, one [`Span`], or a list of spans.
///
/// ```
/// use opentui::style::{Color, Stylize};
/// use opentui::widget::Content;
///
/// let plain: Content = "Ready".into();
/// let styled: Content = vec!["Build ".into(), "passed".fg(Color::GREEN).bold()].into();
/// assert_eq!(styled.plain_text(), "Build passed");
/// # drop(plain);
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Content(pub Vec<Span<'static>>);

impl Content {
    pub fn plain_text(&self) -> String {
        self.0.iter().map(|span| span.content.as_ref()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.0.iter().all(|span| span.content.is_empty())
    }

    pub(crate) fn is_plain(&self) -> bool {
        self.0.iter().all(|span| span.style == Default::default() && span.link.is_none())
    }
}

impl From<&str> for Content {
    fn from(text: &str) -> Self {
        Self(vec![Span::raw(text.to_owned())])
    }
}

impl From<String> for Content {
    fn from(text: String) -> Self {
        Self(vec![Span::raw(text)])
    }
}

impl From<&String> for Content {
    fn from(text: &String) -> Self {
        Self::from(text.as_str())
    }
}

impl<'a> From<Span<'a>> for Content {
    fn from(span: Span<'a>) -> Self {
        Self(vec![span.into_owned()])
    }
}

impl<'a> From<Vec<Span<'a>>> for Content {
    fn from(spans: Vec<Span<'a>>) -> Self {
        Self(spans.into_iter().map(Span::into_owned).collect())
    }
}

impl<'a, const N: usize> From<[Span<'a>; N]> for Content {
    fn from(spans: [Span<'a>; N]) -> Self {
        Self(spans.into_iter().map(Span::into_owned).collect())
    }
}
