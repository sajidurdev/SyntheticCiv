const MAX_LEN: usize = 1024;

static mut STRENGTHS: [f64; MAX_LEN] = [0.0; MAX_LEN];
static mut CENTERS_X: [f64; MAX_LEN] = [0.0; MAX_LEN];
static mut CENTERS_Y: [f64; MAX_LEN] = [0.0; MAX_LEN];
static mut VALUES: [f64; MAX_LEN] = [0.0; MAX_LEN];
static mut RESULT: [f64; 3] = [0.0; 3];

#[inline]
fn clamp01(value: f64) -> f64 {
    if value <= 0.0 {
        0.0
    } else if value >= 1.0 {
        1.0
    } else {
        value
    }
}

#[inline]
fn gaussian(strength: f64, distance_sq: f64, inv_two_sigma_sq: f64) -> f64 {
    if strength <= 0.0 {
        return 0.0;
    }
    let x = -distance_sq * inv_two_sigma_sq;
    strength * x.exp()
}

#[inline]
fn bounded_count(count: u32) -> usize {
    let n = count as usize;
    if n > MAX_LEN {
        MAX_LEN
    } else {
        n
    }
}

#[no_mangle]
pub extern "C" fn max_len() -> u32 {
    MAX_LEN as u32
}

#[no_mangle]
pub extern "C" fn strengths_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(STRENGTHS) as *mut f64
}

#[no_mangle]
pub extern "C" fn centers_x_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(CENTERS_X) as *mut f64
}

#[no_mangle]
pub extern "C" fn centers_y_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(CENTERS_Y) as *mut f64
}

#[no_mangle]
pub extern "C" fn values_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(VALUES) as *mut f64
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(RESULT) as *mut f64
}

#[no_mangle]
pub extern "C" fn sum_gaussian(px: f64, py: f64, count: u32, sigma: f64) -> f64 {
    if sigma <= 0.0 {
        return 0.0;
    }
    let n = bounded_count(count);
    if n == 0 {
        return 0.0;
    }
    let inv_two_sigma_sq = 1.0 / (2.0 * sigma * sigma);
    let mut sum = 0.0;

    for i in 0..n {
        let (dx, dy, strength) = unsafe {
            (
                CENTERS_X[i] - px,
                CENTERS_Y[i] - py,
                STRENGTHS[i],
            )
        };
        let d_sq = dx * dx + dy * dy;
        sum += gaussian(strength, d_sq, inv_two_sigma_sq);
    }

    sum
}

#[no_mangle]
pub extern "C" fn steering_gaussian(px: f64, py: f64, count: u32, sigma: f64) {
    if sigma <= 0.0 {
        unsafe {
            RESULT[0] = 0.0;
            RESULT[1] = 0.0;
            RESULT[2] = 0.0;
        }
        return;
    }

    let n = bounded_count(count);
    if n == 0 {
        unsafe {
            RESULT[0] = 0.0;
            RESULT[1] = 0.0;
            RESULT[2] = 0.0;
        }
        return;
    }

    let inv_two_sigma_sq = 1.0 / (2.0 * sigma * sigma);
    let mut vx = 0.0;
    let mut vy = 0.0;
    let mut total = 0.0;

    for i in 0..n {
        let (dx, dy, strength) = unsafe {
            (
                CENTERS_X[i] - px,
                CENTERS_Y[i] - py,
                STRENGTHS[i],
            )
        };

        let d_sq = dx * dx + dy * dy;
        let infl = gaussian(strength, d_sq, inv_two_sigma_sq);
        if infl <= 1e-9 {
            continue;
        }

        let len = d_sq.sqrt();
        if len <= 1e-9 {
            continue;
        }

        vx += (dx / len) * infl;
        vy += (dy / len) * infl;
        total += infl;
    }

    if total <= 1e-9 {
        unsafe {
            RESULT[0] = 0.0;
            RESULT[1] = 0.0;
            RESULT[2] = 0.0;
        }
        return;
    }

    let vec_len = (vx * vx + vy * vy).sqrt();
    if vec_len <= 1e-9 {
        unsafe {
            RESULT[0] = 0.0;
            RESULT[1] = 0.0;
            RESULT[2] = clamp01(total);
        }
        return;
    }

    unsafe {
        RESULT[0] = vx / vec_len;
        RESULT[1] = vy / vec_len;
        RESULT[2] = clamp01(total);
    }
}

#[no_mangle]
pub extern "C" fn fill_values_from_point(px: f64, py: f64, count: u32, sigma: f64) {
    let n = bounded_count(count);
    if n == 0 || sigma <= 0.0 {
        for i in 0..n {
            unsafe {
                VALUES[i] = 0.0;
            }
        }
        return;
    }

    let inv_two_sigma_sq = 1.0 / (2.0 * sigma * sigma);
    for i in 0..n {
        let (dx, dy, strength) = unsafe {
            (
                CENTERS_X[i] - px,
                CENTERS_Y[i] - py,
                STRENGTHS[i],
            )
        };
        let d_sq = dx * dx + dy * dy;
        unsafe {
            VALUES[i] = gaussian(strength, d_sq, inv_two_sigma_sq);
        }
    }
}
