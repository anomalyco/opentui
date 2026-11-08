use super::Context;
use crate::error::{Result, check, cleanup};
use crate::sys;

type Destroy = unsafe extern "C" fn(*mut sys::ot_context, *const sys::ot_handle) -> sys::ot_status;

/// One Context-owned native object, destroyed on drop. It keeps its Context alive.
pub(crate) struct Resource {
    context: Context,
    handle: sys::ot_handle,
    destroy: Destroy,
    name: &'static str,
}

impl Drop for Resource {
    fn drop(&mut self) {
        cleanup(self.name, unsafe { (self.destroy)(self.context.as_raw(), &self.handle) });
    }
}

impl Resource {
    /// Runs a native constructor and takes ownership of the handle it returns.
    pub fn create(
        context: &Context,
        operation: &'static str,
        destroy: (&'static str, Destroy),
        create: impl FnOnce(*mut sys::ot_context, *mut sys::ot_handle) -> sys::ot_status,
    ) -> Result<Self> {
        let mut handle = sys::ot_handle::default();
        check(operation, create(context.as_raw(), &mut handle))?;
        Ok(Self { context: context.clone(), handle, destroy: destroy.1, name: destroy.0 })
    }

    pub fn context(&self) -> &Context {
        &self.context
    }

    pub fn raw(&self) -> (*mut sys::ot_context, *const sys::ot_handle) {
        (self.context.as_raw(), &self.handle)
    }

    pub fn handle(&self) -> sys::ot_handle {
        self.handle
    }
}

/// Runs a native "zero capacity reports the count" query twice: once for the size, once to copy.
pub(crate) fn read_bytes(
    operation: &'static str,
    mut query: impl FnMut(*mut u8, u32, &mut u32) -> sys::ot_status,
) -> Result<Vec<u8>> {
    let mut length = 0;
    check(operation, query(std::ptr::null_mut(), 0, &mut length))?;
    if length == 0 {
        return Ok(Vec::new());
    }
    let mut bytes = vec![0; length as usize];
    check(operation, query(bytes.as_mut_ptr(), length, &mut length))?;
    bytes.truncate(length as usize);
    Ok(bytes)
}

pub(crate) fn read_string(
    operation: &'static str,
    query: impl FnMut(*mut u8, u32, &mut u32) -> sys::ot_status,
) -> Result<String> {
    read_bytes(operation, query).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}
