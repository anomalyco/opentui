//! A hierarchical slot tree for plugins, as Core's `SlotTree`.
//!
//! A host mounts named dot paths (`prompt.footer`, `prompt.footer.status`); a path contains every path it prefixes.
//! Owners (plugins) claim places relative to a path, and the pure [`resolve`] turns the mounted paths and the ordered
//! claims into what each mounted path shows. A mounted [`Slot`] is a widget with no box of its own, like a
//! [`Fragment`]: the claims before it, then the replacing claim or the claims prepended, its [`Slot::content`] and the
//! claims appended, then the claims after it.
//!
//! A change shows when the call that makes it through a slot returns, or else at a settle the tree defers to its app,
//! which runs before the next frame.

use crate::app::{App, AppInner};
use crate::widget::{AnyWidget, Behavior, Element, Fragment, Widget, build};
use std::borrow::Borrow;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A sibling before the target, outside its boundary.
    Before,
    /// First inside the target's boundary.
    Prepend,
    /// Last inside the target's boundary.
    Append,
    /// A sibling after the target, outside its boundary.
    After,
    /// Takes the target over; its content and every claim inside it are suppressed.
    Replace,
}

/// Where a claim goes: one kind and one absolute target path.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Placement {
    pub kind: Kind,
    pub target: String,
}

impl Placement {
    pub fn new(kind: Kind, target: impl Into<String>) -> Self {
        Self { kind, target: target.into() }
    }

    pub fn before(target: impl Into<String>) -> Self {
        Self::new(Kind::Before, target)
    }

    pub fn prepend(target: impl Into<String>) -> Self {
        Self::new(Kind::Prepend, target)
    }

    pub fn append(target: impl Into<String>) -> Self {
        Self::new(Kind::Append, target)
    }

    pub fn after(target: impl Into<String>) -> Self {
        Self::new(Kind::After, target)
    }

    pub fn replace(target: impl Into<String>) -> Self {
        Self::new(Kind::Replace, target)
    }
}

/// The claims one path shows besides its content: indices into the claims passed to [`resolve`], or claim IDs from
/// [`Tree::resolution`].
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Placed<T = usize> {
    pub before: Vec<T>,
    pub prepend: Vec<T>,
    pub append: Vec<T>,
    pub after: Vec<T>,
    pub replace: Option<T>,
}

impl<T> Default for Placed<T> {
    fn default() -> Self {
        Self { before: Vec::new(), prepend: Vec::new(), append: Vec::new(), after: Vec::new(), replace: None }
    }
}

/// The claims of the mounted paths: placed, suppressed and degraded.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Resolution<T = usize> {
    /// Each targeted path's claims; an untargeted path is absent and shows only its content.
    pub placed: HashMap<String, Placed<T>>,
    /// A suppressed claim and the claim that won, if any; none when no mounted path takes it.
    pub suppressed: Vec<(T, Option<T>)>,
    /// A claim whose target is not mounted, appended to this mounted ancestor instead.
    pub degraded: Vec<(T, String)>,
}

impl<T> Default for Resolution<T> {
    fn default() -> Self {
        Self { placed: HashMap::new(), suppressed: Vec::new(), degraded: Vec::new() }
    }
}

impl Resolution {
    fn map<T>(&self, id: impl Fn(usize) -> T) -> Resolution<T> {
        let ids = |list: &[usize]| -> Vec<T> { list.iter().map(|&index| id(index)).collect() };
        let placed = self.placed.iter().map(|(path, placed)| {
            let (before, prepend, append, after) =
                (ids(&placed.before), ids(&placed.prepend), ids(&placed.append), ids(&placed.after));
            (path.clone(), Placed { before, prepend, append, after, replace: placed.replace.map(&id) })
        });
        Resolution {
            placed: placed.collect(),
            suppressed: self.suppressed.iter().map(|&(index, by)| (id(index), by.map(&id))).collect(),
            degraded: self.degraded.iter().map(|(index, path)| (id(*index), path.clone())).collect(),
        }
    }
}

/// Whether `path` is strictly inside `ancestor`.
pub fn contains(ancestor: &str, path: &str) -> bool {
    path.len() > ancestor.len() && path.starts_with(ancestor) && path.as_bytes()[ancestor.len()] == b'.'
}

/// Resolves `claims`, in order, against the mounted `paths`. Per target the last replacement wins; an accepted
/// replacement suppresses every claim inside it, whatever the order; an additive claim on a path that is not mounted
/// appends to its nearest mounted ancestor; a replacement of a path that is not mounted is suppressed.
pub fn resolve<P: Borrow<Placement>>(paths: &[&str], claims: &[P]) -> Resolution {
    let mut resolution = Resolution::default();

    // Replacement boundaries: the last claim per target, then shallow boundaries first so a nested one meets its
    // container. A replaced claim's winner is known once the boundaries are: its entry is filled in then.
    let mut winners: Vec<(&str, usize)> = Vec::new();
    let mut displaced: Vec<(usize, &str)> = Vec::new();
    for (index, claim) in claims.iter().map(P::borrow).enumerate() {
        if claim.kind != Kind::Replace {
            continue;
        }
        if !paths.contains(&claim.target.as_str()) {
            resolution.suppressed.push((index, None));
            continue;
        }
        match winners.iter_mut().find(|(target, _)| *target == claim.target) {
            Some(winner) => {
                displaced.push((resolution.suppressed.len(), winner.0));
                resolution.suppressed.push((winner.1, None));
                winner.1 = index;
            }
            None => winners.push((&claim.target, index)),
        }
    }
    winners.sort_by_key(|(path, _)| path.split('.').count());
    let mut boundaries: Vec<(&str, usize)> = Vec::new();
    for (path, winner) in winners {
        match containing(&boundaries, path) {
            Some(outer) => resolution.suppressed.push((winner, Some(outer))),
            None => boundaries.push((path, winner)),
        }
    }
    for (at, target) in displaced {
        let boundary = boundaries.iter().find(|(path, _)| *path == target).map(|(_, winner)| *winner);
        resolution.suppressed[at].1 = boundary.or_else(|| containing(&boundaries, target));
    }

    for (index, claim) in claims.iter().map(P::borrow).enumerate() {
        let target = claim.target.as_str();
        // Inside placements on a replaced boundary are its contents; siblings of the boundary stay outside.
        let inside = match claim.kind {
            Kind::Replace => continue,
            Kind::Prepend | Kind::Append => boundaries.iter().find(|(path, _)| *path == target).map(|(_, at)| *at),
            Kind::Before | Kind::After => None,
        };
        if let Some(outer) = inside.or_else(|| containing(&boundaries, target)) {
            resolution.suppressed.push((index, Some(outer)));
            continue;
        }
        if paths.contains(&target) {
            let placed = resolution.placed.entry(target.to_owned()).or_default();
            match claim.kind {
                Kind::Before => placed.before.push(index),
                Kind::Prepend => placed.prepend.push(index),
                Kind::Append => placed.append.push(index),
                Kind::After => placed.after.push(index),
                Kind::Replace => unreachable!("a replacement is a boundary"),
            }
            continue;
        }
        let ancestor = target.rmatch_indices('.').find_map(|(at, _)| paths.iter().find(|path| **path == &target[..at]));
        let Some(ancestor) = ancestor else {
            resolution.suppressed.push((index, None));
            continue;
        };
        resolution.degraded.push((index, (*ancestor).to_owned()));
        resolution.placed.entry((*ancestor).to_owned()).or_default().append.push(index);
    }

    for (path, winner) in boundaries {
        resolution.placed.entry(path.to_owned()).or_default().replace = Some(winner);
    }
    resolution
}

fn containing(boundaries: &[(&str, usize)], path: &str) -> Option<usize> {
    boundaries.iter().find(|(boundary, _)| contains(boundary, path)).map(|(_, winner)| *winner)
}

/// What a claim's render returns: the app's own type, which the tree keeps while the claim shows.
pub trait Mount<I> {
    /// The widget the slot shows for the claim. Each call returns the same widget.
    fn root(&self) -> AnyWidget;

    /// Takes a new input of the slot in place and returns true, or returns false, as the default does, to be
    /// rendered again with it. A new mount begins before the old one ends.
    fn set_input(&self, _input: &I) -> bool {
        false
    }
}

/// A widget renders again with each new input.
impl<I> Mount<I> for AnyWidget {
    fn root(&self) -> AnyWidget {
        self.clone()
    }
}

/// One claim, unique in its tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ClaimId(u64);

/// Why [`Owner::claim`] made no claim on `path`, or [`Slot::mount`] or [`WeakSlot::mount`] mounted no slot `path`
/// inside the slot `within`.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum MountError {
    /// `path` is not names joined by dots, none of them empty (`""`, `.a` and `a..b` are not).
    InvalidPath { path: String },
    /// `path` does not extend `within`.
    NotContained { path: String, within: String },
    /// The slot of a [`WeakSlot`] is no longer mounted.
    Unmounted { path: String, within: String },
}

impl std::fmt::Display for MountError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath { path } => {
                write!(formatter, "{path:?} is not a slot path: a name between dots is empty")
            }
            Self::NotContained { path, within } => {
                write!(formatter, "slot {path:?} cannot mount inside slot {within:?}: its path does not extend it")
            }
            Self::Unmounted { path, within } => {
                write!(formatter, "slot {path:?} cannot mount inside slot {within:?}: that slot is no longer mounted")
            }
        }
    }
}

impl std::error::Error for MountError {}

/// `path`, or [`MountError::InvalidPath`] unless it is names joined by dots, none of them empty.
fn check_path(path: &str) -> Result<&str, MountError> {
    match path.split('.').all(|name| !name.is_empty()) {
        true => Ok(path),
        false => Err(MountError::InvalidPath { path: path.to_owned() }),
    }
}

type Render<I, M> = Box<dyn Fn(&App, &I, WeakSlot<I, M>) -> M>;
type Claims<I, M> = Vec<Rc<Claim<I, M>>>;
type Owners<I, M> = Vec<(Rc<str>, Claims<I, M>)>;

struct Claim<I, M> {
    id: ClaimId,
    placement: Placement,
    render: Render<I, M>,
}

/// The claims in order, and their resolution against the mounted paths.
struct Resolved<I, M> {
    claims: Claims<I, M>,
    resolution: Resolution,
}

/// The slot tree: owners and their claims, the mounted slots, and the resolution of both. Claims are in the owners'
/// order, then in the order each owner made them.
///
/// A change made through a slot ([`Tree::mount`], [`Slot::set_input`]) or in a [`Tree::batch`] shows when the call
/// returns. Any other change (a claim, an owner's reset or order, the last slot of a path dropping) shows at a settle
/// the tree defers to the app of its slots, which runs it before the next frame.
///
/// `I` is the input of a slot, `M` a mounted claim; both are `'static`, as a slot is a widget.
pub struct Tree<I, M = AnyWidget> {
    this: Weak<Self>,
    /// Each owner and its claims, in the owners' order.
    owners: RefCell<Owners<I, M>>,
    /// The latest [`Tree::order`] list, which also places the owners that open after it.
    ranking: RefCell<Vec<Rc<str>>>,
    claims: Cell<u64>,
    /// Each mounted path and its count of mounted slots.
    mounted: RefCell<HashMap<Rc<str>, usize>>,
    slots: RefCell<Vec<Weak<SlotInner<I, M>>>>,
    /// The slots a settle pass syncs, kept for its capacity.
    stale: RefCell<Vec<Weak<SlotInner<I, M>>>>,
    resolved: RefCell<Option<Rc<Resolved<I, M>>>>,
    /// The list [`Slot::each`] walks, kept for its capacity.
    walk: RefCell<Vec<Rc<M>>>,
    /// Changes with every change of the claims, their order or the mounted paths.
    generation: Cell<u64>,
    /// The app of the slot mounted last, which runs the settles the tree defers.
    app: RefCell<Weak<AppInner>>,
    /// Defers a settle: set by [`Tree::new`], which has the bounds a settle needs, for a slot's drop, which has none.
    defer: fn(&Self),
    /// Whether a deferred settle is queued.
    deferred: Cell<bool>,
    settling: Cell<bool>,
}

impl<I, M> Tree<I, M> {
    /// Marks the resolution stale; the next settle applies it.
    fn invalidate(&self) {
        self.resolved.replace(None);
        self.generation.set(self.generation.get() + 1);
    }

    /// A change outside a settle defers one.
    fn changed(&self) {
        self.invalidate();
        if !self.settling.get() && !self.deferred.get() {
            (self.defer)(self);
        }
    }

    /// The place of owner `id`. An owner that is not open opens with no claims, so nothing changes: before the first
    /// open owner the ranking lists after it, else last.
    fn open(&self, id: &str) -> usize {
        let mut owners = self.owners.borrow_mut();
        if let Some(at) = owners.iter().position(|(owner, _)| &**owner == id) {
            return at;
        }
        let ranking = self.ranking.borrow();
        let mut later = ranking.iter().skip_while(|listed| &***listed != id).skip(1);
        let at = later.find_map(|listed| owners.iter().position(|(owner, _)| owner == listed)).unwrap_or(owners.len());
        owners.insert(at, (Rc::from(id), Vec::new()));
        at
    }

    /// Applies the ranking to the open owners: the ranked ones take the places the ranked ones hold, in ranking
    /// order; the others stay. Returns whether one moved.
    fn rank(&self) -> bool {
        let mut owners = self.owners.borrow_mut();
        let ranking = self.ranking.borrow();
        let listed = || ranking.iter().filter_map(|id| owners.iter().position(|(owner, _)| owner == id));
        if listed().is_sorted() {
            return false;
        }
        let listed: Vec<usize> = listed().collect();
        let mut places = listed.clone();
        places.sort_unstable();
        let mut taken: Vec<_> = owners.drain(..).map(Some).collect();
        let mut from: Vec<usize> = (0..taken.len()).collect();
        places.iter().zip(&listed).for_each(|(&place, &owner)| from[place] = owner);
        *owners = from.into_iter().map(|at| taken[at].take().expect("each owner moves once")).collect();
        true
    }
}

impl<I: Clone + PartialEq + 'static, M: Mount<I> + 'static> Tree<I, M> {
    pub fn new() -> Rc<Self> {
        Rc::new_cyclic(|this| Self {
            this: this.clone(),
            owners: RefCell::default(),
            ranking: RefCell::default(),
            claims: Cell::new(0),
            mounted: RefCell::default(),
            slots: RefCell::default(),
            stale: RefCell::default(),
            resolved: RefCell::default(),
            walk: RefCell::default(),
            generation: Cell::new(1),
            app: RefCell::default(),
            defer: Self::defer_settle,
            deferred: Cell::new(false),
            settling: Cell::new(false),
        })
    }

    /// Opens owner `id`, last or where [`Tree::order`] puts it, or returns it in the place it has.
    pub fn owner(&self, id: &str) -> Owner<I, M> {
        let at = self.open(id);
        let id = self.owners.borrow()[at].0.clone();
        Owner { tree: self.this.upgrade().expect("a tree is reached through its Rc"), id }
    }

    /// Sets the owners' order: the listed owners take the places the listed owners hold, in list order; the others
    /// stay where they are. The list is kept, so a listed owner that opens later, or again, takes its place in it. The
    /// list the tree has changes nothing and allocates nothing.
    pub fn order(&self, ids: &[&str]) {
        let unique = || ids.iter().enumerate().filter(|&(at, id)| !ids[..at].contains(id)).map(|(_, id)| *id);
        let mut ranking = self.ranking.borrow_mut();
        if unique().eq(ranking.iter().map(|id| &**id)) {
            return;
        }
        // In place, each id taking the one the list or an open owner has: an app that orders at each start allocates
        // only as the list grows.
        let owners = self.owners.borrow();
        for (at, id) in unique().enumerate() {
            match ranking[at..].iter().position(|listed| &**listed == id) {
                Some(from) => ranking.swap(at, at + from),
                None => {
                    let open = owners.iter().find(|(owner, _)| &**owner == id).map(|(owner, _)| owner.clone());
                    ranking.insert(at, open.unwrap_or_else(|| Rc::from(id)));
                }
            }
        }
        ranking.truncate(unique().count());
        drop((ranking, owners));
        if self.rank() {
            self.changed();
        }
    }

    /// Removes every owner, as [`Owner::remove`] does. The [`Tree::order`] list stays.
    pub fn clear(&self) {
        let owners = self.owners.take();
        if owners.iter().any(|(_, claims)| !claims.is_empty()) {
            self.changed();
        }
    }

    /// Mounts one instance of the host's slot `path`, which shows its claims when this returns. The path stays mounted
    /// while any of its slots lives; the slot is a widget, so a parent that holds it keeps it alive. `app` builds the
    /// slot's widget and runs the settles the tree defers. A claim nests slots with [`Slot::mount`].
    ///
    /// # Panics
    ///
    /// If `path` is not names joined by dots, none of them empty: a host mounts its own paths, so a bad one is a
    /// programming error. [`Slot::mount`] returns [`MountError::InvalidPath`] instead.
    pub fn mount(&self, app: &App, path: &str, input: I) -> Slot<I, M> {
        if let Err(error) = check_path(path) {
            panic!("{error}");
        }
        let next = Rc::downgrade(app.inner());
        // A settle deferred to another app may never run: the next change defers one to this app.
        if !self.app.borrow().ptr_eq(&next) {
            self.deferred.set(false);
        }
        drop(self.app.replace(next));
        let content = Fragment::new(app);
        let tree = self.this.upgrade().expect("a tree is reached through its Rc");
        let path = self.mounted.borrow().get_key_value(path).map_or_else(|| Rc::from(path), |(path, _)| path.clone());
        let (input, version, shown, seen) = (RefCell::new(input), Cell::new(0), RefCell::default(), Cell::new(0));
        let inner = build(app, None, |element| SlotInner { element, tree, path, input, version, content, shown, seen });
        let count = *self.mounted.borrow_mut().entry(inner.path.clone()).and_modify(|count| *count += 1).or_insert(1);
        // It settles below, so it defers no settle.
        if count == 1 {
            self.invalidate();
        }
        self.slots.borrow_mut().push(Rc::downgrade(&inner));
        self.settle();
        Slot(inner)
    }

    /// Runs `f`, which may mount slots and change claims, and settles once when it ends, so a parent slot can mount
    /// before the slots it holds without showing their claims on the way. Inside a render, the settle that runs it
    /// settles.
    pub fn batch<T>(&self, f: impl FnOnce() -> T) -> T {
        if self.settling.replace(true) {
            return f();
        }
        let value = {
            let _settling = Settling(&self.settling);
            f()
        };
        self.settle();
        value
    }

    /// Applies what changed (claims, owners, mounted paths, inputs) to every mounted slot, in place: a claim that still
    /// shows keeps its mount, and the content keeps its widgets. The tree defers a settle itself; this one shows the
    /// changes now.
    pub fn settle(&self) {
        // A render that mounts or drops a slot settles here, in the loop below.
        if self.settling.replace(true) {
            return;
        }
        let _settling = Settling(&self.settling);
        // A pass mounts or drops a claim, or finds every slot current. The bound only stops claims that keep mounting
        // and dropping each other's slots.
        let claims: usize = self.owners.borrow().iter().map(|(_, claims)| claims.len()).sum();
        let passes = 2 * claims + self.slots.borrow().len() + 2;
        for _ in 0..passes {
            let generation = self.generation.get();
            // Weak, so a slot that a sync before it drops is skipped; the tree's list, reused.
            let mut stale = self.stale.take();
            {
                let mut slots = self.slots.borrow_mut();
                slots.retain(|slot| slot.strong_count() > 0);
                let slots =
                    slots.iter().filter(|slot| slot.upgrade().is_some_and(|slot| slot.seen.get() != generation));
                stale.extend(slots.cloned());
            }
            let done = stale.is_empty();
            stale.iter().filter_map(Weak::upgrade).for_each(|slot| slot.sync());
            stale.clear();
            *self.stale.borrow_mut() = stale;
            if done {
                break;
            }
        }
    }

    /// The claims of the mounted paths: placed, suppressed and degraded.
    pub fn resolution(&self) -> Resolution<ClaimId> {
        let resolved = self.resolved();
        resolved.resolution.map(|index| resolved.claims[index].id)
    }

    /// Queues one settle on the app of the slots, if it runs.
    fn defer_settle(&self) {
        let Some(app) = self.app.borrow().upgrade() else { return };
        self.deferred.set(true);
        let tree = self.this.clone();
        App::from_inner(app).defer(move |_| {
            let Some(tree) = tree.upgrade() else { return };
            tree.deferred.set(false);
            tree.settle();
        });
    }

    fn resolved(&self) -> Rc<Resolved<I, M>> {
        if let Some(resolved) = self.resolved.borrow().clone() {
            return resolved;
        }
        let claims: Vec<_> = self.owners.borrow().iter().flat_map(|(_, claims)| claims.iter().cloned()).collect();
        let placements: Vec<&Placement> = claims.iter().map(|claim| &claim.placement).collect();
        let resolution = {
            let mounted = self.mounted.borrow();
            resolve(&mounted.keys().map(|path| &**path).collect::<Vec<_>>(), &placements)
        };
        let resolved = Rc::new(Resolved { claims, resolution });
        *self.resolved.borrow_mut() = Some(resolved.clone());
        resolved
    }
}

/// Ends a settle or a batch, also by a panic the app catches, so the tree settles again.
struct Settling<'a>(&'a Cell<bool>);

impl Drop for Settling<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

/// An owner of claims, such as one plugin. It keeps its place in the tree's order while it lives. Once it is removed,
/// its handles do nothing, also after [`Tree::owner`] opens the same id again.
pub struct Owner<I, M = AnyWidget> {
    tree: Rc<Tree<I, M>>,
    /// The tree's own id of this opening, which tells it from a later one.
    id: Rc<str>,
}

impl<I, M> Owner<I, M> {
    /// Adds a claim after the owner's others. `render` makes its mount; it gets the app, the slot's input, and the
    /// slot, which a mount keeps to nest slots in after the render returns. A removed owner's claim shows nowhere.
    ///
    /// # Errors
    ///
    /// [`MountError::InvalidPath`] if the target is not names joined by dots, none of them empty, as Core throws: a
    /// plugin's mistyped path fails its claim, not the app.
    pub fn claim(
        &self,
        placement: Placement,
        render: impl Fn(&App, &I, WeakSlot<I, M>) -> M + 'static,
    ) -> Result<ClaimId, MountError> {
        check_path(&placement.target)?;
        let id = ClaimId(self.tree.claims.get());
        self.tree.claims.set(id.0 + 1);
        let mut owners = self.tree.owners.borrow_mut();
        let Some(at) = self.place(&owners) else { return Ok(id) };
        owners[at].1.push(Rc::new(Claim { id, placement, render: Box::new(render) }));
        drop(owners);
        self.tree.changed();
        Ok(id)
    }

    /// Removes the owner's claim `id`; whether it had it.
    pub fn unclaim(&self, id: ClaimId) -> bool {
        let claim = {
            let mut owners = self.tree.owners.borrow_mut();
            let claims = self.place(&owners).map(|at| &mut owners[at].1);
            claims.and_then(|claims| Some(claims.remove(claims.iter().position(|claim| claim.id == id)?)))
        };
        let Some(claim) = claim else { return false };
        self.tree.changed();
        drop(claim);
        true
    }

    /// Drops the owner's claims and keeps its place: a hot reload or a disable.
    pub fn reset(&self) {
        let claims = {
            let mut owners = self.tree.owners.borrow_mut();
            self.place(&owners).map(|at| std::mem::take(&mut owners[at].1))
        };
        if claims.is_some_and(|claims| !claims.is_empty()) {
            self.tree.changed();
        }
    }

    /// Forgets the owner and its claims. Its handles do nothing after this.
    pub fn remove(&self) {
        let mut owners = self.tree.owners.borrow_mut();
        let Some(at) = self.place(&owners) else { return };
        let (_, dropped) = owners.remove(at);
        drop(owners);
        if !dropped.is_empty() {
            self.tree.changed();
        }
    }

    /// The owner's place, while this opening of it is open.
    fn place(&self, owners: &Owners<I, M>) -> Option<usize> {
        owners.iter().position(|(owner, _)| Rc::ptr_eq(owner, &self.id))
    }
}

struct Shown<M> {
    claim: ClaimId,
    /// Shared, so a call into the mount holds no borrow of the slot.
    mount: Rc<M>,
    /// The slot's input version it was rendered with.
    input: u64,
}

pub(crate) struct SlotInner<I, M> {
    element: Element,
    tree: Rc<Tree<I, M>>,
    path: Rc<str>,
    input: RefCell<I>,
    /// Changes with every new input.
    version: Cell<u64>,
    content: Fragment,
    shown: RefCell<Vec<Shown<M>>>,
    /// The tree's generation this slot shows.
    seen: Cell<u64>,
}

impl<I: 'static, M: 'static> Behavior for SlotInner<I, M> {
    fn element(&self) -> &Element {
        &self.element
    }
}

impl<I, M> Drop for SlotInner<I, M> {
    fn drop(&mut self) {
        let mut mounted = self.tree.mounted.borrow_mut();
        let Some(count) = mounted.get_mut(&*self.path) else { return };
        *count -= 1;
        if *count == 0 {
            mounted.remove(&*self.path);
            drop(mounted);
            self.tree.changed();
        }
    }
}

impl<I: Clone + PartialEq + 'static, M: Mount<I> + 'static> SlotInner<I, M> {
    /// Drops the claims that no longer show here, then mounts the missing ones in order, and places them around the
    /// content. A render that mounts or drops a slot stops it, so the claims resolve again first.
    fn sync(self: &Rc<Self>) {
        let Some(app) = self.element.app() else { return };
        let tree = &self.tree;
        let (generation, version) = (tree.generation.get(), self.version.get());
        // A render may change the claims or this slot's input: then the slot syncs again.
        let current = || tree.generation.get() == generation && self.version.get() == version;
        let resolved = tree.resolved();
        let empty = Placed::default();
        let placed = resolved.resolution.placed.get(&*self.path).unwrap_or(&empty);
        // The parts in order, walked without a list, so a slot that shows what it showed allocates nothing: a claim's
        // index, or `None` for the content, which a replacement takes the place of with the claims inside.
        fn some(list: &[usize]) -> impl Iterator<Item = Option<usize>> + '_ {
            list.iter().copied().map(Some)
        }
        let inside = placed.replace.is_none();
        let (prepend, append) = if inside { (&placed.prepend[..], &placed.append[..]) } else { (&[][..], &[][..]) };
        let parts = || {
            (some(&placed.before).chain(placed.replace.map(Some)).chain(some(prepend)))
                .chain(inside.then_some(None))
                .chain(some(append))
                .chain(some(&placed.after))
        };
        let id = |index: usize| resolved.claims[index].id;
        let wanted = |claim: ClaimId| parts().flatten().any(|index| id(index) == claim);
        let dropped: Vec<_> = self.shown.borrow_mut().extract_if(.., |shown| !wanted(shown.claim)).collect();
        dropped.iter().for_each(|shown| shown.mount.root().detach());
        // A dropped mount's drop may change the claims: then the slot syncs again.
        drop(dropped);
        if !current() {
            return;
        }
        for index in parts().flatten() {
            let claim = &resolved.claims[index];
            let old = self
                .shown
                .borrow()
                .iter()
                .find(|shown| shown.claim == claim.id)
                .map(|shown| (shown.input, shown.mount.clone()));
            if old.as_ref().is_some_and(|(input, _)| *input == version) {
                continue;
            }
            let input = self.input.borrow().clone();
            // A mount that takes the new input in place stays; else the claim renders again.
            let kept = old.as_ref().is_some_and(|(_, mount)| mount.set_input(&input));
            // One that changed the tree or the input renders, if it still shows, when the slot syncs again.
            if !kept && !current() {
                break;
            }
            let mount = (!kept).then(|| Rc::new((claim.render)(&app, &input, self.downgrade())));
            let mut shown = self.shown.borrow_mut();
            let replaced = match shown.iter_mut().find(|shown| shown.claim == claim.id) {
                Some(shown) => {
                    shown.input = version;
                    mount.map(|mount| std::mem::replace(&mut shown.mount, mount))
                }
                None => {
                    let mount = mount.expect("a claim not shown renders");
                    shown.push(Shown { claim: claim.id, mount, input: version });
                    None
                }
            };
            drop(shown);
            // The old mount ends after the new one began, so a slot both nest stays mounted.
            replaced.inspect(|replaced| replaced.root().detach());
            drop(old);
            if !current() {
                break;
            }
        }
        // Each part's widget in place; a mount leaves the borrow before `Mount::root` runs.
        let mut at = 0;
        for part in parts() {
            let widget = match part {
                None => self.content.as_any(),
                Some(index) => {
                    let mount = self
                        .shown
                        .borrow()
                        .iter()
                        .find(|shown| shown.claim == id(index))
                        .map(|shown| shown.mount.clone());
                    let Some(mount) = mount else { continue };
                    mount.root()
                }
            };
            if self.element.child_behavior(at).is_none_or(|child| child.element().id() != widget.id()) {
                self.element.insert(widget.element(), Some(at));
            }
            at += 1;
        }
        while let Some(extra) = self.element.child_behavior(at) {
            extra.element().detach();
        }
        if current() {
            self.seen.set(generation);
        }
    }

    fn downgrade(self: &Rc<Self>) -> WeakSlot<I, M> {
        WeakSlot(Rc::downgrade(self), self.path.clone())
    }
}

/// A mounted slot: a widget with no box of its own that shows the claims before it, the replacing claim or the
/// claims prepended, its content and the claims appended, then the claims after it. It unmounts when it drops.
pub struct Slot<I, M = AnyWidget>(Rc<SlotInner<I, M>>);

impl<I, M> Clone for Slot<I, M> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<I: 'static, M: 'static> Widget for Slot<I, M> {
    fn element(&self) -> &Element {
        &self.0.element
    }
}

impl<I: Clone + PartialEq + 'static, M: Mount<I> + 'static> Slot<I, M> {
    /// The host's own widgets, detached while a claim replaces them.
    pub fn content(&self) -> &Fragment {
        &self.0.content
    }

    pub fn path(&self) -> &str {
        &self.0.path
    }

    /// Mounts slot `path`, which must extend this slot's, to nest inside this one: as [`Tree::mount`].
    ///
    /// # Errors
    ///
    /// [`MountError::InvalidPath`] if a name in `path` is empty, else [`MountError::NotContained`] if `path` does not
    /// extend this slot's.
    pub fn mount(&self, path: &str, input: I) -> Result<Self, MountError> {
        if !contains(&self.0.path, check_path(path)?) {
            return Err(MountError::NotContained { path: path.to_owned(), within: self.0.path.to_string() });
        }
        let app = self.0.element.app().expect("a slot mounts while its app runs");
        Ok(self.0.tree.mount(&app, path, input))
    }

    /// A handle that does not keep the slot mounted, for a mount that nests slots in it after its render returns.
    pub fn downgrade(&self) -> WeakSlot<I, M> {
        self.0.downgrade()
    }

    /// Gives every claim `input`, unless it equals the input the slot has: [`Mount::set_input`] takes it in place, or
    /// the claim renders again.
    pub fn set_input(&self, input: I) {
        if *self.0.input.borrow() == input {
            return;
        }
        drop(self.0.input.replace(input));
        self.0.version.set(self.0.version.get() + 1);
        self.0.seen.set(0);
        self.0.tree.settle();
    }

    /// Calls `f` with each claim mounted when it starts, so the app can sync and restyle them. `f` may change the tree.
    pub fn each(&self, mut f: impl FnMut(&M)) {
        // The tree's list, reused, so a walk allocates only inside another walk.
        let mut mounts = std::mem::take(&mut *self.0.tree.walk.borrow_mut());
        mounts.extend(self.0.shown.borrow().iter().map(|shown| shown.mount.clone()));
        mounts.iter().for_each(|mount| f(mount));
        mounts.clear();
        let mut walk = self.0.tree.walk.borrow_mut();
        if walk.capacity() < mounts.capacity() {
            *walk = mounts;
        }
    }

    /// Whether no claim shows here.
    pub fn is_empty(&self) -> bool {
        self.0.shown.borrow().is_empty()
    }
}

/// A [`Slot`] that does not keep it mounted, from [`Slot::downgrade`].
pub struct WeakSlot<I, M = AnyWidget>(Weak<SlotInner<I, M>>, Rc<str>);

impl<I, M> Clone for WeakSlot<I, M> {
    fn clone(&self) -> Self {
        Self(self.0.clone(), self.1.clone())
    }
}

impl<I, M> WeakSlot<I, M> {
    /// The slot, while it is mounted.
    pub fn upgrade(&self) -> Option<Slot<I, M>> {
        self.0.upgrade().map(Slot)
    }
}

impl<I: Clone + PartialEq + 'static, M: Mount<I> + 'static> WeakSlot<I, M> {
    /// [`Slot::mount`] while the slot is mounted; [`MountError::InvalidPath`] for a bad path, mounted or not, and
    /// [`MountError::Unmounted`] once the slot is gone.
    pub fn mount(&self, path: &str, input: I) -> Result<Slot<I, M>, MountError> {
        check_path(path)?;
        match self.upgrade() {
            Some(slot) => slot.mount(path, input),
            None => Err(MountError::Unmounted { path: path.to_owned(), within: self.1.to_string() }),
        }
    }
}
