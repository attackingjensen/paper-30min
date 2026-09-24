//! 更新安装、任务注册与解析组件操作共用的准入门（#93）。
//!
//! 检查与占用在同一把互斥锁内完成，杜绝「检查通过后另一操作才开始」的交错：
//! 更新安装期间拒绝新任务与组件操作；任务或组件操作进行中拒绝安装更新。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::BridgeError;
use crate::tasks::TaskRegistry;

#[derive(Debug)]
pub struct AdmissionGate {
    lock: Mutex<()>,
    installing_update: AtomicBool,
    component_busy: AtomicBool,
}

/// 更新安装占用：落下即释放（含失败路径；成功路径由安装器接管并退出进程）。
#[derive(Debug)]
pub struct InstallClaim(Arc<AdmissionGate>);

impl Drop for InstallClaim {
    fn drop(&mut self) {
        self.0.installing_update.store(false, Ordering::SeqCst);
    }
}

/// 组件操作占用：落下即释放 busy，后续组件操作与更新安装才可进入。
#[derive(Debug)]
pub struct ComponentClaim(Arc<AdmissionGate>);

impl Drop for ComponentClaim {
    fn drop(&mut self) {
        self.0.component_busy.store(false, Ordering::SeqCst);
    }
}

impl AdmissionGate {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            lock: Mutex::new(()),
            installing_update: AtomicBool::new(false),
            component_busy: AtomicBool::new(false),
        })
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn installing(&self) -> bool {
        self.installing_update.load(Ordering::SeqCst)
    }

    pub fn component_busy(&self) -> bool {
        self.component_busy.load(Ordering::SeqCst)
    }

    /// 任务注册准入：注册动作在锁内完成，更新安装的活动任务检查不可能漏掉它。
    pub fn admit_task<T>(
        &self,
        register: impl FnOnce() -> Result<T, BridgeError>,
    ) -> Result<T, BridgeError> {
        let _guard = self.lock();
        if self.installing() {
            return Err(BridgeError::new(
                "update_busy",
                "更新安装期间不能启动新任务。",
                true,
            ));
        }
        if self.component_busy() {
            return Err(BridgeError::new(
                "component_busy",
                "解析组件正在安装或迁移，请稍后再启动任务。",
                true,
            ));
        }
        register()
    }

    /// 组件操作（安装/卸载/迁移）准入；返回的 claim 持有 busy 直到落下。
    pub fn admit_component(self: &Arc<Self>, registry: &TaskRegistry) -> Result<ComponentClaim, BridgeError> {
        let _guard = self.lock();
        if self.installing() {
            return Err(BridgeError::new(
                "update_busy",
                "请等待主程序更新完成。",
                true,
            ));
        }
        if registry.has_active() {
            return Err(BridgeError::new(
                "tasks_active",
                "请先等待正在运行的任务完成。",
                true,
            ));
        }
        self.component_busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                BridgeError::new("component_busy", "解析组件正在处理另一项操作。", true)
            })?;
        Ok(ComponentClaim(Arc::clone(self)))
    }

    /// 更新安装准入；返回的 claim 持有 installing 标记直到落下（覆盖下载安装全程）。
    pub fn admit_update(self: &Arc<Self>, registry: &TaskRegistry) -> Result<InstallClaim, BridgeError> {
        let _guard = self.lock();
        if self.component_busy() {
            return Err(BridgeError::new(
                "component_busy",
                "请等待解析组件操作完成后再安装更新。",
                true,
            ));
        }
        if registry.has_active() {
            return Err(BridgeError::new(
                "tasks_active",
                "请先等待运行中的任务完成或取消，再安装更新。",
                true,
            ));
        }
        self.installing_update
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| BridgeError::new("update_busy", "更新安装已在进行中。", false))?;
        Ok(InstallClaim(Arc::clone(self)))
    }
}
