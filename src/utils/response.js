const success = (res, data = {}, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data });

const error = (res, message = 'Internal server error', statusCode = 500, details = null) =>
  res.status(statusCode).json({ success: false, message, ...(details && { details }) });

const paginated = (res, items, total, page, limit) =>
  res.status(200).json({
    success: true,
    data: items,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });

module.exports = { success, error, paginated };
