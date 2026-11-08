//! Raw declarations for OpenTUI's checked C ABI (`opentui.h`).
//!
//! Everything here is generated from the header by `scripts/generate-ffi.ts`. The declarations follow the header
//! exactly: callers must uphold its pointer, ownership, owner-thread, and phase contracts. Record `Default`
//! implementations zero every field and fill in `struct_size` and `abi_version` where the record has them. They set
//! ABI metadata only, not application limits or paint defaults.
//!
//! The safe API lives in the `opentui` crate.

#![no_std]
#![allow(non_camel_case_types)]

/// A record whose bytes are all field bytes.
///
/// Viewing a `Pod` record as `&[u8]` reads only initialized memory, which paint recordings and property streams need.
///
/// # Safety
///
/// Implementors must be `repr(C)`, contain no padding, and contain only integers, floats, and arrays or records of
/// them. The generator emits implementations only for records that satisfy this.
pub unsafe trait Pod: Copy + 'static {}

/// Views a padding-free record as its bytes.
pub fn bytes_of<T: Pod>(value: &T) -> &[u8] {
    // SAFETY: `T: Pod` has no padding, so every byte is initialized, and the slice borrows `value`.
    unsafe { core::slice::from_raw_parts((value as *const T).cast::<u8>(), core::mem::size_of::<T>()) }
}

include!("generated.rs");
