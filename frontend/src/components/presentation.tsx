"use client";

import { ArrowRight, Code2, LayoutGrid, Monitor } from "lucide-react";

export function Presentation() {
  return (
    <div className="presentation">
      <div className="slide-top">
        <span>
          <span className="tiny-square" /> HỆ THỐNG PHÂN TÁN
        </span>
        <span>BUỔI 05 / 12</span>
      </div>
      <div className="slide-content">
        <div className="slide-kicker">KIẾN TRÚC & THIẾT KẾ HỆ THỐNG</div>
        <h2>
          Từ một máy chủ
          <br />
          đến <em>cả một hệ thống.</em>
        </h2>
        <p>Cách các thành phần kết nối, giao tiếp và cùng mở rộng.</p>
        <div className="architecture">
          <div className="diagram-node client">
            <Monitor size={24} />
            <b>Người dùng</b>
            <small>Ứng dụng phía máy khách</small>
          </div>
          <div className="connector">
            <span />
            <ArrowRight size={14} />
          </div>
          <div className="diagram-node gateway">
            <LayoutGrid size={25} />
            <b>Bộ cân bằng tải</b>
            <small>Điều phối yêu cầu</small>
          </div>
          <div className="branch">
            <span />
            <i />
            <i />
          </div>
          <div className="service-stack">
            <div>
              <span className="status-dot" />
              <Code2 size={17} /> Dịch vụ A <span>01</span>
            </div>
            <div>
              <span className="status-dot" />
              <Code2 size={17} /> Dịch vụ B <span>02</span>
            </div>
            <div>
              <span className="status-dot" />
              <Code2 size={17} /> Dịch vụ C <span>03</span>
            </div>
          </div>
        </div>
        <div className="slide-callout">
          <span>01</span>
          <div>
            <b>Mỗi thành phần, một trách nhiệm.</b>
            <small>
              Độc lập triển khai · Linh hoạt mở rộng · Tăng khả năng phục hồi
            </small>
          </div>
        </div>
      </div>
      <div className="slide-bottom">
        <span>
          Nguyễn Hoàng <span> / </span> Khoa Công nghệ thông tin
        </span>
        <span>
          05 <i /> 24
        </span>
      </div>
    </div>
  );
}
