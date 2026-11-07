//! 导出冒烟工具：生成全部支持格式的样例文件，便于人工检查排版与打开效果。
//!
//! 用法：
//!   cargo run --example export_demo -- <输出目录> [图谱 JSON 路径]
//!
//! - 不传图谱路径、路径不存在或解析失败 → 自动回退内置示例图谱，保证测试闭环；
//! - 覆盖 HTML / PNG / PDF / DOCX / Markdown / JSON 六种格式；
//! - 每次运行都会在输出目录留一份 `sample-graph.json` 快照，可作为下次的图谱入参。
//! - 不依赖前端；仅用于验证导出管线，不写用户数据。

use std::path::{Path, PathBuf};

use termask_workbench_lib::export::{render_bytes, ExportFormat};
use termask_workbench_lib::{ConceptEdge, ConceptNode, GraphProject, GraphTemplateType};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "export-sample".to_string());
    let graph_path = args.get(2).cloned();
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("创建输出目录失败");

    // 内置示例图谱：找不到（或无法解析）本地图谱文件时使用，保证导出测试闭环。
    let mut project = GraphProject {
        id: "demo".into(),
        title: "认知负荷与学习设计".into(),
        template_type: GraphTemplateType::Free,
        nodes: vec![
            ConceptNode {
                id: "n1".into(),
                label: "认知负荷".into(),
                level: Some(1),
                description: Some("工作记忆在单位时间内需要处理的信息总量".into()),
                position: None,
            },
            ConceptNode {
                id: "n2".into(),
                label: "内在负荷".into(),
                level: Some(2),
                description: Some("由材料本身复杂度决定，难以通过教学设计消除".into()),
                position: None,
            },
            ConceptNode {
                id: "n3".into(),
                label: "外在负荷".into(),
                level: Some(2),
                description: Some("由呈现方式与无关信息造成，可通过设计降低".into()),
                position: None,
            },
            ConceptNode {
                id: "n4".into(),
                label: "图式构建".into(),
                level: Some(3),
                description: Some("把新信息与既有知识结构连接的过程".into()),
                position: None,
            },
        ],
        edges: vec![
            ConceptEdge {
                id: "e1".into(),
                source: "n1".into(),
                target: "n2".into(),
                label: Some("包含".into()),
            },
            ConceptEdge {
                id: "e2".into(),
                source: "n1".into(),
                target: "n3".into(),
                label: Some("包含".into()),
            },
            ConceptEdge {
                id: "e3".into(),
                source: "n3".into(),
                target: "n4".into(),
                label: Some("抑制".into()),
            },
        ],
        summary: "认知负荷理论把学习者的工作记忆压力拆成内在与外在两部分。\n\n\
内在负荷来自材料本身的复杂度，教学设计能做的有限；外在负荷来自呈现方式，是设计的主战场。\n\n\
降低外在负荷，才能把有限的工作记忆留给图式构建。"
            .into(),
        created_at: 0,
        updated_at: 1_760_000_000_000,
    };

    match graph_path.as_deref() {
        Some(p) if Path::new(p).exists() => {
            match std::fs::read_to_string(p)
                .ok()
                .and_then(|raw| serde_json::from_str::<GraphProject>(&raw).ok())
            {
                Some(g) => {
                    println!("使用本地已保存图谱：{p}");
                    project = g;
                }
                None => println!("图谱文件 {p} 无法解析为 GraphProject，自动回退内置示例图谱"),
            }
        }
        Some(p) => println!("未找到图谱文件 {p}，自动回退内置示例图谱"),
        None => println!("未指定图谱文件，使用内置示例图谱"),
    }
    println!(
        "导出数据来源：{} 个节点 / {} 条边",
        project.nodes.len(),
        project.edges.len()
    );

    // 留一份可复用的图谱快照：下次可把它作为第二个参数验证「读取本地图谱」分支。
    let snapshot = dir.join("sample-graph.json");
    std::fs::write(
        &snapshot,
        serde_json::to_string_pretty(&project).expect("序列化图谱失败"),
    )
    .expect("写入图谱快照失败");
    println!("图谱快照：{}", snapshot.display());

    for (fmt, name) in [
        (ExportFormat::Html, "demo.html"),
        (ExportFormat::Png, "demo.png"),
        (ExportFormat::Pdf, "demo.pdf"),
        (ExportFormat::Docx, "demo.docx"),
        (ExportFormat::Markdown, "demo.md"),
        (ExportFormat::Json, "demo.json"),
    ] {
        match render_bytes(&project, fmt) {
            Ok(bytes) => {
                let path = dir.join(name);
                std::fs::write(&path, &bytes).expect("写入失败");
                println!("{} -> {} 字节", path.display(), bytes.len());
            }
            Err(e) => println!("{name} 失败: {e}"),
        }
    }
}
