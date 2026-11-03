use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AllowedNetworksInput {
    #[serde(default)]
    pub ipv4: Vec<String>,
    #[serde(default)]
    pub ipv6: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CompiledPolicy {
    pub networks: Vec<IpNet>,
}

impl CompiledPolicy {
    pub fn from_input(input: &AllowedNetworksInput) -> Result<Self, String> {
        let mut networks = Vec::new();
        for cidr in &input.ipv4 {
            let net: IpNet = cidr.parse().map_err(|e| format!("Invalid IPv4 CIDR {}: {}", cidr, e))?;
            networks.push(net);
        }
        for cidr in &input.ipv6 {
            let net: IpNet = cidr.parse().map_err(|e| format!("Invalid IPv6 CIDR {}: {}", cidr, e))?;
            networks.push(net);
        }
        Ok(Self { networks })
    }

    pub fn is_allowed(&self, addr: IpAddr) -> bool {
        let normalized = normalize_ip(addr);
        for net in &self.networks {
            if net.contains(&normalized) {
                return true;
            }
        }
        false
    }
}

pub fn normalize_ip(addr: IpAddr) -> IpAddr {
    match addr {
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                IpAddr::V4(v4)
            } else {
                IpAddr::V6(v6)
            }
        }
        IpAddr::V4(v4) => IpAddr::V4(v4),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ipv4_and_mapped_ipv6() {
        let input = AllowedNetworksInput {
            ipv4: vec!["203.0.113.0/24".into()],
            ipv6: vec!["2001:db8::/32".into()],
        };
        let policy = CompiledPolicy::from_input(&input).unwrap();

        assert!(policy.is_allowed("203.0.113.42".parse().unwrap()));
        assert!(policy.is_allowed("::ffff:203.0.113.42".parse().unwrap()));
        assert!(!policy.is_allowed("203.0.114.42".parse().unwrap()));
        assert!(policy.is_allowed("2001:db8:1::42".parse().unwrap()));
        assert!(!policy.is_allowed("2001:db9::42".parse().unwrap()));
    }
}
